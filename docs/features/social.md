# Social Scout Service (type `social`)

> **Naming:** In the UI, this appears as "Social Scout". The backend type code is `social`.

Social media profile monitoring with post diffing and criteria matching.

## Current runtime note

The live runtime is the Supabase Edge Function path:
- kickoff: `social-kickoff`
- async processing: `apify-callback` / `apify-reconcile`
- canonical writes: `_shared/unit_dedup.ts` → `upsert_canonical_unit`

Social scouts use the same canonical dedup service as web/beat/civic, but
with a stricter semantic boundary: exact matches may merge across scout types,
while semantic matching does not cross between `social` and `non-social`
canonical rows.

## Overview

Social Scouts monitor social media profiles for new (and optionally removed) posts. Four platforms are supported:

| Platform | Apify Actor ID | Media Support |
|----------|----------------|---------------|
| Instagram | `pmQcv69sB1UwguQUY` | Text + images + video URLs |
| X/Twitter | `61RPP7dywgiy0JPD0` | Text + media URLs |
| Facebook | `cleansyntax~facebook-profile-posts-scraper` | Text + images + video URLs |
| TikTok | `novi~tiktok-user-api` | Text + cover image + video URLs |

Two monitor modes:

| Mode | Behavior |
|------|----------|
| **Summarize** | AI-generated summary of new posts, always notifies when new posts found |
| **Criteria** | Embed new posts on-the-fly, compare against criteria via cosine similarity (threshold > 0.65) |

Optional **removal tracking** (`track_removals: true`) detects posts that disappear between runs.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  SOCIAL SCOUT EXECUTION                          │
│                                                                  │
│  Trigger: EventBridge → Lambda → POST /api/social/execute        │
│           OR: UI test → POST /api/social/test                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: Scrape Profile (Apify)                                  │
│  ├─ Start actor run via apify_client                             │
│  ├─ Poll every 2s until complete (max 120s)                      │
│  └─ Normalize raw output → NormalizedPost[]                      │
│           │                                                      │
│           ▼                                                      │
│  Step 2: ID-Based Diffing (Layer 1)                              │
│  ├─ Load previous POSTS# snapshot from DynamoDB                  │
│  ├─ identify_new_posts: IDs in current but not previous          │
│  └─ identify_removed_posts: IDs in previous but not current      │
│           │                                                      │
│           ▼                                                      │
│  Step 3: Mode-Specific Processing                                │
│  ├─ If "summarize": AI summary of new posts (OpenRouter)         │
│  └─ If "criteria": embed + cosine similarity (Layer 2)           │
│           │                                                      │
│           ▼                                                      │
│  Step 4: Notify + Store                                          │
│  ├─ Send email notification (Resend)                             │
│  ├─ Store EXEC# record                                           │
│  ├─ Overwrite POSTS# snapshot with current posts                 │
│  └─ Decrement credits                                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Two-Layer Detection

### Layer 1: ID-Based Diffing

The baseline stored in `POSTS#` contains post IDs only (no embeddings). Each execution scrapes the profile, compares post IDs against the baseline, and identifies:

- **New posts** — IDs present in current scrape but absent from previous snapshot (`identify_new_posts`)
- **Removed posts** — IDs present in previous snapshot but absent from current scrape (`identify_removed_posts`, only when `track_removals` is enabled)

Scheduled creation establishes this baseline server-side for UI, API, CLI, and MCP callers. The UI scan can pass preview baseline posts as an optimization, but non-UI agents only need `platform` and `profile_handle`; the create endpoint performs the baseline scrape before scheduling. Run Now refuses to execute a social scout with no saved baseline instead of treating existing posts as new.

### Layer 2: Criteria Matching (on-the-fly embeddings)

Only runs in `criteria` mode, and only on new posts identified by Layer 1.

1. Embed the user's criteria text as a `RETRIEVAL_QUERY`
2. Embed each new post at execution time:
   - **Instagram/TikTok/Facebook**: multimodal embedding (text + first image via Gemini) when images available
   - **X**: text-only embedding (typically no images)
   - All platforms fall back to text-only when no images are available
3. Compare via cosine similarity — posts with similarity > 0.65 are matches

The baseline never stores embeddings because they are only needed for the criteria comparison, not for diffing.

## Multimodal Embedding

Uses **Gemini Embedding 2** (`gemini-embedding-2-preview`, 1536 dimensions) via `embedding_utils.py`.

| Platform | Embedding Type | Input |
|----------|---------------|-------|
| Instagram/TikTok/Facebook (with images) | Multimodal | `"{author}: {text}"` + first image bytes |
| Any platform (no images) | Text-only | `"{author}: {text}"` |

Image bytes are downloaded from CDN URLs via `download_image()` (15s timeout, graceful fallback to text-only on failure).

## Data Models

### NormalizedPost

Unified representation across platforms:

```python
class NormalizedPost(BaseModel):
    id: str                          # Platform-native post ID
    url: str                         # Direct link to post
    text: str                        # Caption (Instagram) or tweet text
    author: str                      # Username/handle
    timestamp: str                   # ISO timestamp
    image_urls: List[str] = []       # Image CDN URLs (Instagram only in Phase 1)
    video_url: Optional[str] = None  # Video URL (Instagram only, when isVideo)
    platform: SocialPlatform         # "instagram" | "x" | "facebook" | "tiktok"
    engagement: dict = {}            # Platform-specific metrics
```

Engagement fields by platform:
- **Instagram**: `likes`, `comments`
- **X**: `likes`, `retweets`, `replies`
- **Facebook**: `likes`, `comments`, `shares`
- **TikTok**: empty (content-only — journalists monitor against criteria, not metrics)

### PostSnapshot

Lightweight record stored in the POSTS# baseline:

```python
class PostSnapshot(BaseModel):
    post_id: str
    caption_truncated: str           # First 200 chars
    image_url: Optional[str] = None  # First image URL
    timestamp: str
```

### DynamoDB POSTS# Records

```
Table: scraping-jobs
PK: {user_id}
SK: POSTS#{scout_name}
Fields:
  posts: JSON string of PostSnapshot[]
  platform: "instagram" | "x" | "facebook" | "tiktok"
  handle: profile handle
  updated_at: ISO timestamp
  post_count: int
  ttl: 90 days from write time
```

### Request/Response Schemas

```python
class SocialTestRequest(BaseModel):
    platform: SocialPlatform         # "instagram" | "x" | "facebook" | "tiktok"
    handle: str                      # Auto-strips leading "@"

class SocialTestResponse(BaseModel):
    valid: bool
    profile_url: str
    error: Optional[str] = None
    post_ids: List[str] = []         # Baseline IDs for snapshot
    preview_posts: List[dict] = []   # Truncated preview for UI
    posts_data: List[dict] = []      # Full snapshot data to store at schedule time

class SocialExecuteRequest(BaseModel):
    userId: str
    scraperName: str
    platform: SocialPlatform
    profile_handle: str
    monitor_mode: SocialMonitorMode  # "summarize" | "criteria"
    track_removals: bool = False
    criteria: Optional[str] = None
    topic: Optional[str] = Field(None, max_length=200)
    preferred_language: str = "en"
```

## API Endpoints

### POST /social/test (session auth)

Validate a social media profile and scrape baseline posts.

**Auth:** Session cookie (`get_current_user`)

**Request:**
```json
{
  "platform": "instagram",
  "handle": "buriedsignals"
}
```

**Response (success):**
```json
{
  "valid": true,
  "profile_url": "https://www.instagram.com/buriedsignals/",
  "post_ids": ["3595...001", "3594...002"],
  "preview_posts": [
    {"id": "3595...001", "text": "First 120 chars of caption...", "timestamp": "2026-03-10T12:00:00Z"}
  ],
  "posts_data": [
    {"post_id": "3595...001", "caption_truncated": "First 200 chars...", "image_url": "https://...", "timestamp": "2026-03-10T12:00:00Z"}
  ]
}
```

**Response (invalid profile):**
```json
{
  "valid": false,
  "profile_url": "https://www.instagram.com/nonexistent/",
  "error": "Profile not found or inaccessible"
}
```

### POST /social/execute (service key auth)

Full social scout execution: scrape, diff, summarize/criteria, notify, store.

**Auth:** `X-Service-Key` header (`verify_service_key`)

**Request:**
```json
{
  "userId": "user_abc123",
  "scraperName": "my-social-scout",
  "platform": "x",
  "profile_handle": "nytimes",
  "monitor_mode": "summarize",
  "track_removals": false,
  "preferred_language": "en"
}
```

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "3 new posts about...",
  "notification_sent": true,
  "new_posts": 3,
  "removed_posts": 0,
  "total_posts": 20
}
```

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `social_orchestrator.py` | `backend/app/services/` | Normalization, diffing, embedding, summary, notification |
| `social.py` | `backend/app/routers/` | `/api/social/*` endpoints |
| `social.py` | `backend/app/schemas/` | Request/response Pydantic models |
| `modes.py` | `backend/app/models/` | `SocialPlatform` and `SocialMonitorMode` type definitions |
| `apify_client.py` | `backend/app/workflows/` | Apify actor start/poll functions |
| `embedding_utils.py` | `backend/app/services/` | Gemini Embedding 2 (text + multimodal) |
| `execution_deduplication.py` | `backend/app/services/` | EXEC# record storage |
| `notification_service.py` | `backend/app/services/` | Email notifications via Resend |

## Apify Actors

### Instagram: `pmQcv69sB1UwguQUY`

- Input: profile URL, `max_items`
- Output fields: `id`, `code`, `caption`, `owner.username`, `createdAt`, `image.url`, `video.url`, `isVideo`, `likeCount`, `commentCount`
- Normalization: `normalize_instagram_posts()`

### X/Twitter: `61RPP7dywgiy0JPD0`

- Input: profile URL, `max_tweets`
- Output fields: `id`, `id_str`, `text`, `author.username`, `created_at`, `url`, `favorite_count`, `retweet_count`, `reply_count`
- Normalization: `normalize_x_posts()`

### Facebook: `cleansyntax~facebook-profile-posts-scraper`

- Input: profile URL, `max_posts`
- Output fields: `post_id`, `message`, `timestamp` (unix), `author.name`, `image.uri`, `album_preview`, `video.url`, `reactions_count`, `comments_count`, `reshare_count`
- Normalization: `normalize_facebook_posts()`
- Rejects Facebook Page URLs (only personal profiles)

### TikTok: `novi~tiktok-user-api`

- Input: profile URL, `limit`
- Output fields: `aweme_id`, `desc`, `create_time` (unix), `share_url`, `author.unique_id`, `video.cover.url_list`, `video.play_addr.url_list`
- Normalization: `normalize_tiktok_posts()`
- Content-only: no engagement metrics (journalists monitor against criteria, not vanity metrics)
- Cover image used for multimodal embedding

All actors are started asynchronously and polled every 2 seconds until completion or 120-second timeout.

## Credit Cost

| Platform | Scheduled execution | Test |
|----------|-------------------|------|
| Instagram | 2 | 0 |
| X/Twitter | 2 | 0 |
| Facebook | 15 | 0 |
| TikTok | 2 | 0 |

## Benchmarking

```bash
cd backend
python scripts/benchmark_social.py              # Quick benchmark (2 profiles)
python scripts/benchmark_social.py --audit       # Full audit (all scenarios + report)
```

Tests profile validation, Apify scraping, post normalization, ID-based diffing, AI summary generation, and criteria matching across both platforms and both monitor modes.

## Related Docs

- `docs/architecture/records-and-deduplication.md` - DynamoDB record types and dedup layers
