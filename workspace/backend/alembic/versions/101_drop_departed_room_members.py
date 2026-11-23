"""Rooms forget bots that are no longer in their workspace.

Removing an agent from a workspace used to leave its channel_members rows
behind, so rooms kept listing a bot that had gone ("disconnected" forever).
The router now removes them with the agent; this clears the rows already left,
and points a room's master_agent at a remaining member (or none).

Revision ID: 101
Revises: 100
"""
from alembic import op

# Deletes only rows no running code can use (their agent no longer exists).
deployment_backward_compatible = True
revision = '101'
down_revision = '100'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        DELETE FROM channel_members cm
        USING channels c
        WHERE cm.channel_id = c.id
          AND NOT EXISTS (
            SELECT 1 FROM workspace_members wm
            WHERE wm.workspace_id = c.workspace_id AND wm.agent_name = cm.agent_name
          )
    """)
    op.execute("""
        UPDATE channels c
        SET master_agent = (
            SELECT cm.agent_name FROM channel_members cm
            WHERE cm.channel_id = c.id ORDER BY cm.agent_name LIMIT 1
        )
        WHERE c.master_agent IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM channel_members cm
            WHERE cm.channel_id = c.id AND cm.agent_name = c.master_agent
          )
    """)


def downgrade():
    # The rows named agents that no longer exist; nothing to bring back.
    pass
