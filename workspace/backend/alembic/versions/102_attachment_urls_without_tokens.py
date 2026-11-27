"""Stored messages forget the tokens in their attachment URLs.

The web client stored each attachment's URL with ?token=<workspace token>
&access_token=<the sender's sign-in token>, so anyone who could read a thread
or its events could copy the sender's session. New messages are stored
without them (app/services/message_attachments.py); this cleans the ones
already stored. Every client builds the link from fileId when it shows a
message, so nothing reads the stored URL's query.

Revision ID: 102
Revises: 101
"""
import json

import sqlalchemy as sa
from alembic import op

# Only drops query parameters no running code reads.
deployment_backward_compatible = True
revision = '102'
down_revision = '101'
branch_labels = None
depends_on = None


def upgrade():
    from app.services.message_attachments import payload_without_credentials

    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT id, payload FROM events "
        "WHERE payload ? 'attachments' AND payload::text LIKE '%token=%'"
    )).fetchall()
    for event_id, payload in rows:
        payload = payload if isinstance(payload, dict) else json.loads(payload)
        cleaned = payload_without_credentials(payload)
        if cleaned is not payload:
            conn.execute(
                sa.text("UPDATE events SET payload = CAST(:p AS jsonb) WHERE id = :id"),
                {"p": json.dumps(cleaned), "id": event_id},
            )


def downgrade():
    pass
