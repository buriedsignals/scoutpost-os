"""Tests for user service."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from decimal import Decimal
from app.services.user_service import InsufficientCreditsError, UserService, resolve_tier, _apply_admin_override


# --- Tier Resolution (pure function, no mocks needed) ---

def test_resolve_tier_no_entitlements():
    tier, credits, update_on, org_uuid = resolve_tier([])
    assert tier == "free"
    assert credits == 100
    assert update_on is None
    assert org_uuid is None


def test_resolve_tier_pro():
    orgs = [
        {
            "uuid": "org-1",
            "entitlements": [
                {"name": "cojournalist-pro", "resources": {"monthly_credits": 1000}, "update_on": "2026-04-01"}
            ],
        }
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "pro"
    assert credits == 1000
    assert update_on == "2026-04-01"
    assert org_uuid is None


def test_resolve_tier_team():
    orgs = [
        {
            "uuid": "org-1",
            "entitlements": [
                {"name": "cojournalist-team", "resources": {"monthly_credits": 5000}, "update_on": "2026-05-01"}
            ],
        }
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "team"
    assert credits == 5000
    assert update_on == "2026-05-01"
    assert org_uuid == "org-1"


def test_resolve_tier_highest_wins():
    """Team > Pro > Free."""
    orgs = [
        {"uuid": "org-1", "entitlements": [{"name": "cojournalist-pro", "resources": {"monthly_credits": 1000}, "update_on": "2026-04-01"}]},
        {"uuid": "org-2", "entitlements": [{"name": "cojournalist-team", "resources": {"monthly_credits": 5000}, "update_on": "2026-05-01"}]},
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "team"
    assert credits == 5000
    assert update_on == "2026-05-01"
    assert org_uuid == "org-2"


def test_resolve_tier_ignores_non_cojournalist_entitlements():
    orgs = [
        {"uuid": "org-1", "entitlements": [{"name": "muckrock-pro", "resources": {}, "update_on": "2026-04-01"}]},
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "free"
    assert credits == 100
    assert update_on is None
    assert org_uuid is None


def test_resolve_tier_reads_monthly_credits_from_resources():
    """Credit cap comes from MuckRock resources, not hardcoded."""
    orgs = [
        {
            "uuid": "org-1",
            "entitlements": [
                {"name": "cojournalist-pro", "resources": {"monthly_credits": 2000}, "update_on": "2026-04-01"}
            ],
        }
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "pro"
    assert credits == 2000
    assert org_uuid is None


def test_resolve_tier_defaults_when_resources_missing():
    """Fallback defaults when resources dict is empty."""
    orgs = [
        {"uuid": "org-1", "entitlements": [{"name": "cojournalist-pro", "resources": {}}]},
    ]
    tier, credits, update_on, org_uuid = resolve_tier(orgs)
    assert tier == "pro"
    assert credits == 1000  # default
    assert update_on is None
    assert org_uuid is None


# --- Admin Email Override (pure function, patched settings) ---

@patch("app.services.user_service.get_settings")
def test_admin_override_free_to_pro(mock_settings):
    mock_settings.return_value.admin_emails = "admin@example.com"
    tier, cap = _apply_admin_override("admin@example.com", "free", 100)
    assert tier == "pro"
    assert cap == 1000


@patch("app.services.user_service.get_settings")
def test_admin_override_team_not_downgraded(mock_settings):
    mock_settings.return_value.admin_emails = "admin@example.com"
    tier, cap = _apply_admin_override("admin@example.com", "team", 5000)
    assert tier == "team"
    assert cap == 5000


@patch("app.services.user_service.get_settings")
def test_admin_override_pro_stays_pro(mock_settings):
    mock_settings.return_value.admin_emails = "admin@example.com"
    tier, cap = _apply_admin_override("admin@example.com", "pro", 1000)
    assert tier == "pro"
    assert cap == 1000


@patch("app.services.user_service.get_settings")
def test_admin_override_non_admin_unchanged(mock_settings):
    mock_settings.return_value.admin_emails = "admin@example.com"
    tier, cap = _apply_admin_override("regular@example.com", "free", 100)
    assert tier == "free"
    assert cap == 100


@patch("app.services.user_service.get_settings")
def test_admin_override_empty_config(mock_settings):
    mock_settings.return_value.admin_emails = ""
    tier, cap = _apply_admin_override("anyone@example.com", "free", 100)
    assert tier == "free"
    assert cap == 100


@patch("app.services.user_service.get_settings")
def test_admin_override_case_insensitive(mock_settings):
    mock_settings.return_value.admin_emails = "Admin@Example.COM"
    tier, cap = _apply_admin_override("admin@example.com", "free", 100)
    assert tier == "pro"
    assert cap == 1000


@patch("app.services.user_service.get_settings")
def test_admin_override_whitespace_handling(mock_settings):
    mock_settings.return_value.admin_emails = " admin@test.com , other@test.com "
    tier, cap = _apply_admin_override("other@test.com", "free", 100)
    assert tier == "pro"
    assert cap == 1000


@patch("app.services.user_service.get_settings")
def test_admin_override_empty_email(mock_settings):
    mock_settings.return_value.admin_emails = "admin@example.com"
    tier, cap = _apply_admin_override("", "free", 100)
    assert tier == "free"
    assert cap == 100


# --- Storage Adapter Operations (mocked via AsyncMock) ---


def _make_service():
    """Create UserService with an AsyncMock storage adapter."""
    mock_storage = AsyncMock()
    svc = UserService(user_storage=mock_storage)
    return svc, mock_storage


@pytest.mark.asyncio
async def test_get_or_create_user_creates_profile():
    """New user: delegates create_or_update_user and create_credits to adapter."""
    svc, mock_storage = _make_service()
    mock_storage.get_user.return_value = None  # User doesn't exist

    userinfo = {
        "uuid": "user-uuid-123",
        "email": "test@example.com",
        "name": "Test User",
        "preferred_username": "testuser",
        "organizations": [],
    }

    user = await svc.get_or_create_user(userinfo)
    assert user["user_id"] == "user-uuid-123"
    assert user["muckrock_id"] == "user-uuid-123"
    # email/name are not stored — fetched on-demand from MuckRock
    assert "email" not in user
    assert "name" not in user
    assert user["tier"] == "free"
    assert user["credits"] == 100  # monthly_cap returned directly for new users
    mock_storage.create_or_update_user.assert_called_once()
    mock_storage.create_credits.assert_called_once_with(
        user_id="user-uuid-123", monthly_cap=100, tier="free", update_on=None
    )


@pytest.mark.asyncio
async def test_get_or_create_user_preserves_existing_preferences():
    """Returning user: existing profile preferences are preserved in the returned dict."""
    svc, mock_storage = _make_service()
    mock_storage.get_user.return_value = {
        "user_id": "user-uuid-123",
        "tier": "free",
        "muckrock_id": "user-uuid-123",
        "timezone": "Europe/Zurich",
        "preferred_language": "de",
        "onboarding_completed": True,
        "credits": 80,
    }
    mock_storage.get_balance.return_value = 80

    userinfo = {
        "uuid": "user-uuid-123",
        "email": "test@example.com",
        "name": "Test User",
        "organizations": [],
    }

    user = await svc.get_or_create_user(userinfo)
    assert user["timezone"] == "Europe/Zurich"
    assert user["preferred_language"] == "de"
    assert user["onboarding_completed"] is True


@pytest.mark.asyncio
async def test_decrement_credits_atomic():
    """decrement_credits delegates to storage.decrement_credits()."""
    svc, mock_storage = _make_service()
    mock_storage.decrement_credits.return_value = True

    await svc.decrement_credits("user-uuid-123", 2)
    mock_storage.decrement_credits.assert_called_once_with("user-uuid-123", 2)


@pytest.mark.asyncio
async def test_decrement_credits_insufficient_raises():
    """decrement_credits raises InsufficientCreditsError when adapter returns False."""
    svc, mock_storage = _make_service()
    mock_storage.decrement_credits.return_value = False

    with pytest.raises(InsufficientCreditsError):
        await svc.decrement_credits("user-uuid-123", 2)


@pytest.mark.asyncio
async def test_get_or_create_user_caps_balance_on_downgrade():
    """When tier downgrades, balance is capped by calling update_credits with balance."""
    svc, mock_storage = _make_service()
    mock_storage.get_user.return_value = {
        "user_id": "user-1",
        "tier": "pro",
        "muckrock_id": "user-1",
        "credits": 800,
        "onboarding_completed": True,
    }
    # get_balance returns 800 (first call — downgrade check), then 100 (final return)
    mock_storage.get_balance.side_effect = [800, 100]

    userinfo = {
        "uuid": "user-1",
        "organizations": [],  # No entitlements = free tier
    }

    user = await svc.get_or_create_user(userinfo)
    assert user["tier"] == "free"

    # Verify balance cap call: update_credits called with {"balance": 100}
    update_calls = mock_storage.update_credits.call_args_list
    cap_calls = [c for c in update_calls if c.args[1].get("balance") == 100]
    assert len(cap_calls) == 1


@pytest.mark.asyncio
async def test_get_or_create_user_no_cap_on_upgrade():
    """When tier upgrades, balance is NOT capped."""
    svc, mock_storage = _make_service()
    mock_storage.get_user.return_value = {
        "user_id": "user-1",
        "tier": "free",
        "muckrock_id": "user-1",
        "credits": 50,
        "onboarding_completed": False,
    }
    mock_storage.get_balance.return_value = 50  # 50 < 1000, no cap needed

    userinfo = {
        "uuid": "user-1",
        "organizations": [
            {"uuid": "org-1", "entitlements": [{"name": "cojournalist-pro", "resources": {"monthly_credits": 1000}, "update_on": "2026-04-01"}]}
        ],
    }

    user = await svc.get_or_create_user(userinfo)
    assert user["tier"] == "pro"

    # No balance capping: no update_credits call with "balance" key
    update_calls = mock_storage.update_credits.call_args_list
    cap_calls = [c for c in update_calls if "balance" in c.args[1]]
    assert len(cap_calls) == 0


# --- ORG# Record CRUD ---

@pytest.mark.asyncio
async def test_create_org_if_not_exists():
    """create_org_if_not_exists delegates to storage.create_org()."""
    svc, mock_storage = _make_service()

    await svc.create_org_if_not_exists(
        org_id="org-uuid-1",
        monthly_cap=5000,
        update_on="2026-05-01",
        org_name="Newsroom Alpha",
    )

    mock_storage.create_org.assert_called_once_with(
        org_id="org-uuid-1",
        monthly_cap=5000,
        update_on="2026-05-01",
        org_name="Newsroom Alpha",
    )


@pytest.mark.asyncio
async def test_create_org_idempotent():
    """create_org_if_not_exists delegates idempotency to adapter (no exceptions raised)."""
    svc, mock_storage = _make_service()
    mock_storage.create_org.return_value = None  # adapter handles idempotency silently

    # Should NOT raise
    await svc.create_org_if_not_exists(
        org_id="org-uuid-1",
        monthly_cap=5000,
        update_on="2026-05-01",
        org_name="Newsroom Alpha",
    )
    mock_storage.create_org.assert_called_once()


@pytest.mark.asyncio
async def test_get_org_balance():
    """_get_org_balance delegates to storage.get_org_balance()."""
    svc, mock_storage = _make_service()
    mock_storage.get_org_balance.return_value = 4500

    balance = await svc._get_org_balance("org-uuid-1")
    assert balance == 4500
    mock_storage.get_org_balance.assert_called_once_with("org-uuid-1")


@pytest.mark.asyncio
async def test_get_org_balance_missing():
    """_get_org_balance returns 0 when adapter returns 0."""
    svc, mock_storage = _make_service()
    mock_storage.get_org_balance.return_value = 0

    balance = await svc._get_org_balance("org-uuid-1")
    assert balance == 0


@pytest.mark.asyncio
async def test_get_org_credits_info():
    """get_org_credits_info delegates to storage.get_org_credits()."""
    svc, mock_storage = _make_service()
    mock_storage.get_org_credits.return_value = {
        "balance": 4500,
        "monthly_cap": 5000,
        "seated_count": 3,
        "org_name": "Newsroom Alpha",
        "update_on": "2026-05-01",
    }

    info = await svc.get_org_credits_info("org-uuid-1")
    assert info is not None
    assert info["balance"] == 4500
    assert info["monthly_cap"] == 5000
    assert info["seated_count"] == 3
    assert info["org_name"] == "Newsroom Alpha"
    assert info["update_on"] == "2026-05-01"
    mock_storage.get_org_credits.assert_called_once_with("org-uuid-1")


@pytest.mark.asyncio
async def test_get_org_credits_info_missing():
    """get_org_credits_info returns None when adapter returns None."""
    svc, mock_storage = _make_service()
    mock_storage.get_org_credits.return_value = None

    info = await svc.get_org_credits_info("org-uuid-1")
    assert info is None


@pytest.mark.asyncio
async def test_decrement_org_credits_atomic():
    """decrement_org_credits delegates to storage.decrement_org_credits()."""
    svc, mock_storage = _make_service()
    mock_storage.decrement_org_credits.return_value = True

    await svc.decrement_org_credits("org-uuid-1", 50)
    mock_storage.decrement_org_credits.assert_called_once_with("org-uuid-1", 50)


@pytest.mark.asyncio
async def test_decrement_org_credits_insufficient_raises():
    """decrement_org_credits raises InsufficientCreditsError when adapter returns False."""
    svc, mock_storage = _make_service()
    mock_storage.decrement_org_credits.return_value = False

    with pytest.raises(InsufficientCreditsError):
        await svc.decrement_org_credits("org-uuid-1", 50)


# --- Seat Claiming ---

@pytest.mark.asyncio
async def test_claim_seat_success():
    """claim_seat delegates to storage.claim_seat() and returns True."""
    svc, mock_storage = _make_service()
    mock_storage.claim_seat.return_value = True

    result = await svc.claim_seat("org-team-1", "user-1", "free")
    assert result is True
    mock_storage.claim_seat.assert_called_once_with("org-team-1", "user-1", "free")


@pytest.mark.asyncio
async def test_claim_seat_already_member():
    """claim_seat returns True when user already a member (adapter handles idempotency)."""
    svc, mock_storage = _make_service()
    mock_storage.claim_seat.return_value = True

    result = await svc.claim_seat("org-team-1", "user-1", "free")
    assert result is True


@pytest.mark.asyncio
async def test_claim_seat_org_not_found():
    """claim_seat returns False when ORG# record doesn't exist (adapter returns False)."""
    svc, mock_storage = _make_service()
    mock_storage.claim_seat.return_value = False

    result = await svc.claim_seat("org-team-1", "user-1", "free")
    assert result is False


# --- Team Login Flow ---

@pytest.mark.asyncio
async def test_get_or_create_user_team_new_user():
    """New user with team entitlement: creates org and claims seat."""
    svc, mock_storage = _make_service()
    mock_storage.get_user.return_value = None  # User doesn't exist
    mock_storage.claim_seat.return_value = True

    userinfo = {
        "uuid": "user-new",
        "preferred_username": "newuser",
        "organizations": [
            {
                "uuid": "org-team-1",
                "name": "Test Newsroom",
                "individual": False,
                "entitlements": [
                    {"name": "cojournalist-team", "resources": {"monthly_credits": 5000}, "update_on": "2026-05-01"}
                ],
            }
        ],
    }

    user = await svc.get_or_create_user(userinfo)
    assert user["tier"] == "team"
    assert user["org_id"] == "org-team-1"
    mock_storage.create_org.assert_called_once()
    mock_storage.claim_seat.assert_called_once()


@pytest.mark.asyncio
async def test_update_org_credits_topup():
    """update_org_credits delegates to storage.update_org_credits()."""
    svc, mock_storage = _make_service()

    await svc.update_org_credits("org-uuid-1", new_cap=6000, new_update_on="2026-06-01")

    mock_storage.update_org_credits.assert_called_once_with(
        "org-uuid-1", 6000, "2026-06-01"
    )


@pytest.mark.asyncio
async def test_update_org_credits_downgrade():
    """update_org_credits delegates downgrade logic to adapter."""
    svc, mock_storage = _make_service()

    await svc.update_org_credits("org-uuid-1", new_cap=3000, new_update_on="2026-06-01")

    mock_storage.update_org_credits.assert_called_once_with(
        "org-uuid-1", 3000, "2026-06-01"
    )


@pytest.mark.asyncio
async def test_update_org_credits_no_change():
    """update_org_credits delegates to adapter regardless of cap direction."""
    svc, mock_storage = _make_service()

    await svc.update_org_credits("org-uuid-1", new_cap=5000, new_update_on="2026-06-01")

    mock_storage.update_org_credits.assert_called_once_with(
        "org-uuid-1", 5000, "2026-06-01"
    )
