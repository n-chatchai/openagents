"""Per-thread permission to request work from another person's agent."""
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import select
from app.models import ChannelAgentSharing, ChannelMember
from app.services.access_model import (
    Principal, active_grants, channel_participant_emails, explicit_agent_access,
    explain, grants_for_pairs, resource_for_agent,
)


def sharing_mode(setting):
    if setting and getattr(setting, "enabled", False):
        return "yes"
    return setting.mode if setting and setting.mode in ("yes", "approval") else "no"


@dataclass
class _RoomAccess:
    people: set
    agents: set
    explicit: set
    thread_grants: dict
    sharing_by_owner: dict


def request_access_for_room(db, workspace_id, channel, members, email, people):
    """Load permission inputs in bulk for the ordinary agents in a room."""
    from app.services.guest_links import is_guest_email
    from app.services.room_agents import is_guest_agent
    if not members or not email:
        return {}
    ordinary = [member for member in members
                if member.status != "removed" and not is_guest_agent(member) and member.agent_name != "yumi"]
    access = None
    if ordinary and not is_guest_email(email):
        principal = Principal("human", email=email, workspace_id=str(workspace_id))
        agents = {member.agent_name for member in ordinary}
        explicit = explicit_agent_access(db, workspace_id, principal, ordinary)
        thread_grants = defaultdict(list)
        sharing_by_owner = {}
        if email in people and not channel.service_id:
            for grant in grants_for_pairs(db, workspace_id, [("human", email)], "thread_agent",
                                          [f"{channel.id}:{name}" for name in agents]):
                thread_grants[grant.resource_id].append(grant)
            sharing_by_owner = {setting.owner_email: setting for setting in db.scalars(
                select(ChannelAgentSharing).where(ChannelAgentSharing.channel_id == channel.id)
            )}
        access = _RoomAccess(people, agents, explicit, thread_grants, sharing_by_owner)
    return {member.agent_name: request_access(db, workspace_id, channel, member, email, room_access=access)
            for member in members}


def request_access(db, workspace_id, channel, member, email, *, room_access=None):
    if not member or member.status == "removed" or not email:
        return "no"
    from app.services.guest_links import guest_may_run, is_guest_email
    from app.services.room_agents import guest_agent_may_run, is_guest_agent
    if is_guest_agent(member):
        # An agent a guest brought into a jam: anyone there may ask it (its
        # launcher holds everyone but its own guest to read-only turns).
        return "yes" if guest_agent_may_run(db, workspace_id, channel, member, email) else "no"
    if is_guest_email(email):
        # A guest of a shared thread may run that thread's agents while its
        # link is live, and nothing else; no grant or sharing rule applies.
        return "yes" if guest_may_run(db, workspace_id, channel, member, email) else "no"
    from app.services.personal_assistant import is_yumi, is_personal_channel
    if is_yumi(db, workspace_id, member.agent_name):
        return "yes" if channel and is_personal_channel(db, channel) and email.lower() == (channel.owner_email or "").lower() else "no"
    # Explicit agent grants remain independent of this thread-only setting.
    batched = room_access is not None and member.agent_name in room_access.agents
    if batched:
        explicit = member.agent_name in room_access.explicit
    else:
        principal = Principal("human", email=email, workspace_id=str(workspace_id))
        explicit = explain(db, principal, resource_for_agent(member), "act", str(workspace_id),
                           include_thread_sharing=False).allowed
    if explicit:
        return "yes"
    if not channel or channel.service_id:
        return "no"
    owner = (member.owner_email or "").strip().lower()
    people = room_access.people if batched else channel_participant_emails(db, channel)
    attached = email in people and owner in people and (
        batched or db.get(ChannelMember, (channel.id, member.agent_name)) is not None
    )
    if channel.status != "deleted" and attached:
        resource = f"{channel.id}:{member.agent_name}"
        grants = (room_access.thread_grants.get(resource, []) if batched else
                  active_grants(db, str(workspace_id), "thread_agent", resource, ("human", email)))
        if any("act" in (grant.rights or []) and grant.granted_by == f"human:{owner}" for grant in grants):
            return "yes"
    issue = issue_for_work(db, channel)
    if issue:
        return issue_request_access(db, workspace_id, issue, member, email)
    if not attached:
        return "no"
    setting = (room_access.sharing_by_owner.get(owner) if batched else
               db.get(ChannelAgentSharing, (channel.id, owner)))
    return sharing_mode(setting)


def blocked_notice(db, workspace, channel, member):
    from app.mods.workspace_mod import _post_system_notice
    from app.models import User
    from app.services.guest_links import guest_blocked_text
    guest_text = guest_blocked_text(db, workspace, channel, member)
    if guest_text:
        _post_system_notice(db, workspace, channel.name, guest_text, notice="agent_access_required")
        return
    owner = (member.owner_email or "").strip().lower()
    person = db.execute(select(User).where(User.email == owner)).scalar_one_or_none() if owner else None
    owner_label = (person.display_name if person else None) or owner or "the agent's owner"
    _post_system_notice(db, workspace, channel.name,
        f"Your message was posted, but {member.display_name or member.agent_name} wasn’t asked to work. "
        f"Ask {owner_label} to enable sharing or require approval in this thread’s settings.",
        notice="agent_access_required")


def shared_agent_names(db, workspace_id):
    """Agents whose owners have enabled sharing in a thread they still belong to."""
    from sqlalchemy import or_, func
    from app.models import WorkspaceMember, Channel, ChannelHumanMember
    shared = set(db.execute(select(WorkspaceMember.agent_name)
        .join(ChannelMember, ChannelMember.agent_name == WorkspaceMember.agent_name)
        .join(Channel, Channel.id == ChannelMember.channel_id)
        .join(ChannelAgentSharing, ChannelAgentSharing.channel_id == Channel.id)
        .join(ChannelHumanMember, ChannelHumanMember.channel_id == Channel.id)
        .where(WorkspaceMember.workspace_id == str(workspace_id), Channel.workspace_id == str(workspace_id),
               WorkspaceMember.status != "removed", Channel.service_id.is_(None),
               ChannelAgentSharing.owner_email == func.lower(WorkspaceMember.owner_email),
               ChannelHumanMember.user_email == ChannelAgentSharing.owner_email,
               or_(ChannelAgentSharing.enabled.is_(True), ChannelAgentSharing.mode == "approval"))
    ).scalars().all())

    from app.models import Issue, IssueAgentSharing
    from app.routers.issues import _participants, _linked_channels
    settings = db.execute(select(IssueAgentSharing, Issue).join(Issue, Issue.id == IssueAgentSharing.issue_id)
        .where(Issue.workspace_id == str(workspace_id), IssueAgentSharing.mode.in_(["yes", "approval"]))).all()
    members = db.execute(select(WorkspaceMember).where(WorkspaceMember.workspace_id == str(workspace_id), WorkspaceMember.status != "removed")).scalars().all()
    for setting, issue in settings:
        roster = {person["source"] for person in _participants(db, issue, _linked_channels(db, issue))}
        if f"human:{setting.owner_email}" not in roster:
            continue
        shared.update(member.agent_name for member in members
            if (member.owner_email or "").lower() == setting.owner_email and f"openagents:{member.agent_name}" in roster)
    return shared


def issue_for_work(db, channel):
    from app.models import Issue, IssueThread
    if not channel:
        return None
    if channel.name.startswith("task:"):
        from app.models import KanbanTask
        return db.execute(select(Issue).join(KanbanTask, KanbanTask.issue_id == Issue.id)
            .where(KanbanTask.channel_name == channel.name,
                   KanbanTask.workspace_id == channel.workspace_id,
                   Issue.workspace_id == channel.workspace_id)).scalars().first()
    if not channel.name.startswith("issue-work-"):
        return None
    return db.execute(select(Issue).join(IssueThread, IssueThread.issue_id == Issue.id)
        .where(IssueThread.channel_id == channel.id, Issue.workspace_id == channel.workspace_id)).scalars().first()


def issue_request_access(db, workspace_id, issue, member, email):
    from app.models import IssueAgentSharing
    from app.routers.issues import _participants, _linked_channels
    from app.services.personal_assistant import is_yumi
    if member and is_yumi(db, workspace_id, member.agent_name):
        return "no"
    if not member or member.status == "removed" or not email:
        return "no"
    if explain(db, Principal("human", email=email, workspace_id=str(workspace_id)),
               resource_for_agent(member), "act", str(workspace_id), include_thread_sharing=False).allowed:
        return "yes"
    roster = {p["source"] for p in _participants(db, issue, _linked_channels(db, issue))}
    owner = (member.owner_email or "").strip().lower()
    if not {f"human:{owner}", f"human:{email}", f"openagents:{member.agent_name}"}.issubset(roster):
        return "no"
    return sharing_mode(db.get(IssueAgentSharing, (issue.id, owner)))
