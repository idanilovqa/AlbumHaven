"""Owner orchestration unit doubles only; not PostgreSQL transaction proof."""
import unittest
from contextlib import ExitStack
from dataclasses import dataclass,replace
from datetime import datetime,timezone
from unittest.mock import patch

from music_app.services import listening_goal_completion_postgres as completion
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.owned_album_tops import AlbumTopError

@dataclass(frozen=True)
class Actor:
    account_id:int=7
    session_id:int=9
    current_library_id:int|None=None

@dataclass(frozen=True)
class Context:
    actor:Actor=Actor()
    library_id:int|None=None

class Result:
    def __init__(self,rows):self.rows=rows
    def fetchall(self):return self.rows
    def fetchone(self):return self.rows[0] if self.rows else None

class Connection:
    def __init__(self,libraries=None,tops=None,removed=()):
        self.libraries=[{'library_id':1},{'library_id':2}] if libraries is None else libraries
        self.tops=[{'library_id':1,'ref':'a'},{'library_id':2,'ref':'b'}] if tops is None else tops
        self.removed=removed
        self.sql=[]
    def execute(self,sql,params=()):
        self.sql.append((sql,params))
        if 'from library.library_memberships' in sql:return Result(self.libraries)
        if 'from app.album_lists' in sql:return Result(self.tops)
        if 'from app.album_list_items' in sql:return Result([] if params[0] in self.removed else [{'catalog_ref':'album'}])
        if 'from app.album_list_item_progress' in sql:return Result([{'revision':2}])
        raise AssertionError(sql)

class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.context=Context()
        self.member=self.stack.enter_context(patch.object(completion,'collection_member_context',side_effect=lambda c,ctx,a,lock:ctx))
        self.top=self.stack.enter_context(patch.object(completion.Tops,'_top',side_effect=lambda c,ctx,ref,write:{'ref':ref,'library_id':ctx.library_id}))
        self.require=self.stack.enter_context(patch.object(completion,'require_goal_top_progress'))
        self.active=self.stack.enter_context(patch.object(completion.activity,'read_activity',side_effect=lambda c,ctx,refs:{refs[0]:{'active':True}}))
        self.write=self.stack.enter_context(patch.object(completion.progress,'set_manual_completion',side_effect=lambda c,ctx,cmd,top,now:{'top_ref':top['ref'],'account_id':ctx.actor.account_id}))
    def call(self,connection):
        return completion.propagate_goal_completion(connection,self.context,'album','key',datetime.now(timezone.utc))
    def test_propagates_same_actor_across_libraries_without_selection(self):
        self.assertEqual(self.call(Connection()),[{'top_ref':'a','account_id':7},{'top_ref':'b','account_id':7}])
        self.assertIsNone(self.context.actor.current_library_id)
        self.assertEqual(self.require.call_count,4)
        for call in self.write.call_args_list:
            self.assertEqual(call.args[2].data,{'album_ref':'album','progress_revision':'2','completed':True})
    def test_removed_membership_not_recreated(self):
        self.assertEqual(self.call(Connection(removed=('a',))),[{'top_ref':'b','account_id':7}])
    def test_no_memberships_no_progress_writes(self):
        self.assertEqual(self.call(Connection(libraries=[])),[])
        self.write.assert_not_called()
    def test_inactive_board_left_unchanged_and_active_board_completed(self):
        self.active.side_effect=lambda c,ctx,refs:{refs[0]:{'active':refs[0]!='b'}}
        self.assertEqual(self.call(Connection()),[{'top_ref':'a','account_id':7}])
        self.assertEqual(self.write.call_count,1)
    def test_scope_bounds_fail_closed_before_writes(self):
        for connection in (Connection(libraries=[{'library_id':i} for i in range(101)]),
                           Connection(tops=[{'library_id':1,'ref':str(i)} for i in range(1001)])):
            with self.assertRaisesRegex(GoalsError,'completion_scope_too_large'):self.call(connection)
        self.write.assert_not_called()
    def test_unreadable_board_never_receives_progress(self):
        def require(ctx,top,constraints,write=False):
            if top['ref']=='a':raise AlbumTopError('forbidden',403)
        self.require.side_effect=require
        self.assertEqual(self.call(Connection()),[{'top_ref':'b','account_id':7}])
    def test_final_dynamic_authority_rechecked(self):
        calls=[]
        def require(ctx,top,constraints,write=False):
            calls.append(top['ref'])
            if len(calls)>2:raise AlbumTopError('forbidden',403)
        self.require.side_effect=require
        with self.assertRaisesRegex(GoalsError,'forbidden'):self.call(Connection())
        # Outer real transaction owns rollback; this unit does not simulate it.
        self.assertEqual(self.write.call_count,2)

class RealPolicyTests(unittest.TestCase):
    def context(self):
        from music_app.services.current_actor import ActorState,CurrentActor,LibraryRelationship,CapabilityGrant
        from music_app.services.policy import PolicyContext,RequestOrigin
        actor=CurrentActor(state=ActorState.ACTIVE,account_id=7,session_id=9,current_library_id=None,
            library_relationships=(LibraryRelationship(3,'member',False),),
            capability_grants=tuple(CapabilityGrant(action,'library',3) for action in ('library.browse.read','library.album_tops.progress.manage')))
        return PolicyContext(actor=actor,action='account.self.goals.write',resource=None,target_account_id=7,library_id=3,
            deployment_mode='self_hosted',request_origin=RequestOrigin('network','goal-policy-unit'),client_surface_class='private_web')
    def top(self):return {'ref':'10000000-0000-4000-8000-000000000001','library_id':3,'owner_account_id':7,'visibility':'private','deleted_at':None}
    def test_actual_policies_allow_same_actor_unselected_library_without_switch(self):
        from music_app.services.listening_goal_top_authority import require_goal_top_progress
        context=self.context();require_goal_top_progress(context,self.top(),None,write=True)
        self.assertIsNone(context.actor.current_library_id)
    def test_actual_policies_reject_absent_membership(self):
        from music_app.services.listening_goal_top_authority import require_goal_top_progress
        context=self.context();context=replace(context,actor=replace(context.actor,library_relationships=()))
        with self.assertRaises(AlbumTopError):require_goal_top_progress(context,self.top(),None,write=True)
    def test_actual_policies_reject_another_accounts_private_top(self):
        from music_app.services.listening_goal_top_authority import require_goal_top_progress
        with self.assertRaises(AlbumTopError):require_goal_top_progress(self.context(),{**self.top(),'owner_account_id':99},None,write=True)
    def test_actual_policies_respect_dynamic_progress_deny(self):
        from music_app.services.listening_goal_top_authority import require_goal_top_progress
        from music_app.services.policy_evaluator import PolicyEvaluationConstraints
        def constraints(target):return PolicyEvaluationConstraints(deployment_allowed=target.action!='library.album_tops.progress.manage')
        with self.assertRaises(AlbumTopError):require_goal_top_progress(self.context(),self.top(),constraints,write=True)

if __name__=='__main__':unittest.main()
