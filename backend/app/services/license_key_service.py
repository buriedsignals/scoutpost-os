"""License key validation for legacy automation checks.

PURPOSE: Reads existing LICENSE# records in the scraping-jobs table for the
hidden setup-guide endpoints. Scoutpost billing/subscriptions are managed by
MuckRock entitlements in Supabase; this service does not create or look up
subscription records.

DEPENDS ON: config (AWS region), boto3 (DynamoDB)
USED BY: routers/license.py (validation and setup-guide endpoints)

Records in scraping-jobs table:
- LICENSE#<sha256(key)> / META          -- key_prefix, subscription_id, status, expires_at
"""
import hashlib
from datetime import datetime, timezone
from typing import Optional

import boto3

from app.config import get_settings


class LicenseKeyService:
    TABLE_NAME = "scraping-jobs"

    def __init__(self):
        settings = get_settings()
        self.dynamodb = boto3.resource("dynamodb", region_name=settings.aws_region)
        self.table = self.dynamodb.Table(self.TABLE_NAME)

    def validate_key(self, raw_key: str) -> Optional[dict]:
        """Validate a license key. Returns license record or None.

        Also updates last_validated_at timestamp (fire-and-forget).
        """
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

        response = self.table.get_item(
            Key={"PK": f"LICENSE#{key_hash}", "SK": "META"}
        )
        item = response.get("Item")
        if not item:
            return None

        # Update last_validated_at (fire-and-forget, don't block on this)
        now = datetime.now(timezone.utc).isoformat()
        try:
            self.table.update_item(
                Key={"PK": f"LICENSE#{key_hash}", "SK": "META"},
                UpdateExpression="SET last_validated_at = :now",
                ExpressionAttributeValues={":now": now},
            )
        except Exception:
            pass  # Non-critical -- don't fail validation over a timestamp update

        return item
