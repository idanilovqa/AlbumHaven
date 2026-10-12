"""Scripted SQL checkpoints only; these doubles do not implement PostgreSQL."""
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from music_app.services.current_actor import (
    ActorState, CapabilityGrant, CurrentActor, LibraryRelationship,
)
from music_app.services.owned_playlists import BROWSE, CREATE, ITEMS, MANAGE
from music_app.services.policy import PolicyContext, RequestOrigin


ACCOUNT, SESSION, LIBRARY = 41, 8, 73
NOW = datetime(2026, 10, 8, 22, 0, tzinfo=timezone.utc)
ALL_ACTIONS = (BROWSE, CREATE, MANAGE, ITEMS)
REQUEST = "10000000-0000-4000-8000-000000000001"
PLAYLIST = "20000000-0000-4000-8000-000000000001"
OTHER_PLAYLIST = "20000000-0000-4000-8000-000000000002"
ITEM_A = "30000000-0000-4000-8000-000000000001"
ITEM_B = "30000000-0000-4000-8000-000000000002"
ITEM_C = "30000000-0000-4000-8000-000000000003"
SOURCE = "40000000-0000-4000-8000-000000000001"
SOURCE_REVISION = "50000000-0000-4000-8000-000000000001"
ENTRY_A = "60000000-0000-4000-8000-000000000001"
ENTRY_B = "60000000-0000-4000-8000-000000000002"


def context(*, grants=ALL_ACTIONS, bootstrap=False, **overrides):
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=ACCOUNT, session_id=SESSION,
        username_display="Synthetic member", authenticated_at=NOW,
        current_library_id=LIBRARY, is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(LIBRARY, "member", False),),
        capability_grants=tuple(CapabilityGrant(action, "library", LIBRARY) for action in grants),
    )
    values = dict(actor=actor, action=MANAGE, library_id=LIBRARY,
                  deployment_mode="self_hosted", client_surface_class="private_web",
                  request_origin=RequestOrigin("network", "hmac:synthetic-origin"))
    values.update(overrides)
    return PolicyContext.build(**values)


@dataclass
class Step:
    sql: str
    rows: list = field(default_factory=list)
    params: object = None
    error: Exception | None = None
    after: object = None
    clauses: tuple = ()


class Cursor:
    def __init__(self, rows):
        self.rows = deepcopy(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class Connection:
    """Verify statement sequence and context exits, never simulate committed data."""
    def __init__(self, steps=(), *, commit_error=None):
        self.pending = list(steps)
        self.operations = []
        self.entered = 0
        self.exits = []
        self.commit_error = commit_error

    def __enter__(self):
        self.entered += 1
        return self

    def __exit__(self, exc_type, exc, tb):
        self.exits.append(exc)
        if exc is None and self.commit_error is not None:
            raise self.commit_error
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.casefold().split())
        self.operations.append((sql, deepcopy(params)))
        assert self.pending, f"Unexpected SQL checkpoint: {sql}"
        step = self.pending.pop(0)
        assert step.sql in sql, (step.sql, sql)
        for clause in step.clauses:
            assert clause in sql, (clause, sql)
        if step.params is not None:
            assert params == step.params
        if step.after is not None:
            step.after()
        if step.error is not None:
            raise step.error
        return Cursor(step.rows)

    def done(self):
        assert not self.pending, [step.sql for step in self.pending]

    @property
    def writes(self):
        return [(sql, params) for sql, params in self.operations
                if sql.startswith(("insert ", "update ", "delete "))]


def authority_steps(*, grants=ALL_ACTIONS, bootstrap=False):
    return [
        Step("set transaction isolation level read committed"),
        Step("with locked_accounts", [{"id": ACCOUNT}], (ACCOUNT, ACCOUNT),
             clauses=("order by id for update",)),
        Step("from app.accounts where id=%s", [{"id": ACCOUNT, "is_active": True,
             "disabled_at": None}], (ACCOUNT,)),
        Step("from app.account_sessions", [{"id": SESSION, "account_id": ACCOUNT,
             "authenticated_at": NOW, "idle_expires_at": NOW + timedelta(hours=1),
             "absolute_expires_at": NOW + timedelta(days=1), "revoked_at": None}],
             (SESSION, ACCOUNT), clauses=("for update",)),
        Step("from app.bootstrap_owners", [{"account_id": ACCOUNT}] if bootstrap else [],
             (ACCOUNT,), clauses=("owner_key='local-bootstrap-owner'", "for share")),
        Step("from library.library_memberships", [{"membership_role": "member",
             "is_primary_owner": False}], (ACCOUNT, ACCOUNT, LIBRARY),
             clauses=("for share of m,l",)),
        Step("from app.capabilities", [{"capability_key": key, "scope_kind": "library",
             "scope_id": LIBRARY} for key in grants], (ACCOUNT,),
             clauses=("revoked_at is null", "order by id for share")),
    ]


def receipt_lookup(rows=()):
    return Step("from app.playlist_operations", list(rows), (ACCOUNT, LIBRARY, REQUEST),
                clauses=("for update",))


def playlist_row(**changes):
    return {"ref": PLAYLIST, "owner_account_id": ACCOUNT, "library_id": LIBRARY,
            "revision": 7, "title": "Saved title", "description": "Saved description",
            "visibility": "private", "deleted_at": None, **changes}


def owned_step(rows=None, *, ref=PLAYLIST, write=True):
    return Step("from app.playlists", [playlist_row()] if rows is None else rows,
                (ref, LIBRARY), clauses=("library_id=%s", "for update" if write else "for share"))


def item_row(ref=ITEM_A, track_id=901, position=1, **changes):
    return {"ref": ref, "playlist_ref": PLAYLIST, "library_id": LIBRARY,
            "original_local_track_id": track_id, "local_track_id": track_id,
            "position": position, "title": "Original title", "artist": "Original artist",
            "album_title": "Original album", "original_album_id": 501,
            "release_year": 2020, "disc_number": 1, "track_number": position,
            "duration_seconds": 123, "source_ref": SOURCE, "source_entry_ref": ENTRY_A,
            "source_revision": SOURCE_REVISION, **changes}


def item_step(rows=()):
    return Step("from app.playlist_items", list(rows), (PLAYLIST,), clauses=("order by position",))


def source_row(**changes):
    return {"ref": SOURCE, "revision": SOURCE_REVISION, "library_id": LIBRARY,
            "actor_account_id": ACCOUNT, "session_id": SESSION,
            "protocol": "library_selection_v1", "expires_at": NOW + timedelta(minutes=30),
            "inventory_upper_id": 1000, **changes}


def source_step(rows=None):
    return Step("from app.playlist_creation_sources", [source_row()] if rows is None else rows,
                (SOURCE, ACCOUNT, SESSION, LIBRARY), clauses=("for share",))


def inventory_row(track_id=901, **changes):
    return {"original_local_track_id": track_id, "title": f"Track {track_id}",
            "inventory_evidence": [f"synthetic-track-{track_id}", 301,
                [[701, 601, "/synthetic/private-track.flac", 1024, "2026-10-08T00:00:00Z", "synthetic-signature", False, LIBRARY, True]]],
            "artist": "Synthetic artist", "album_title": "Synthetic album",
            "original_album_id": 501, "release_year": 2020, "disc_number": 1,
            "track_number": 1, "duration_seconds": 123, "availability": "local", **changes}


def inventory_steps(ids, rows, *, lock=True):
    ids = sorted(set(ids))
    result = []
    if lock:
        for table, params in (
            ("local_tracks", (LIBRARY, ids)),
            ("local_albums", (LIBRARY, LIBRARY, ids)),
            ("local_artists", (LIBRARY, LIBRARY, ids)),
            ("local_track_files", (ids,)),
            ("library_roots", (LIBRARY, ids)),
        ):
            lock_clause = "order by id for update" if table == "local_tracks" else "order by id for share"
            result.append(Step(f"select id from library.{table}", params=params,
                               clauses=(lock_clause,)))
    result.append(Step("from library.local_tracks t", rows, (LIBRARY, ids),
                       clauses=("t.library_id=%s", "t.id=any(%s::bigint[])", "order by t.id")))
    return result


def create_body(*, refs=()):
    return {"request_key": REQUEST, "source_protocol": "library_selection_v1", "mode": "ordinary",
            "source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION},
            "title": "New Playlist", "description": "Authored description", "entry_refs": list(refs)}
