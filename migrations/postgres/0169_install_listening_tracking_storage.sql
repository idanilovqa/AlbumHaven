-- Install listening tracking storage through the ordinary transactional runner.
-- PostgreSQL 17 only; stop application writers and retain a verified backup.
-- No feature activation, historical backfill, privilege repair or ledger rewrite.
-- Catalog facts below are independent historical contracts, not candidate output.
set local search_path = pg_catalog;

do $tracking_delivery$
declare
  -- Each category has field-name shapes, explicit row values, and state indexes.
  -- This lossless dictionary coding avoids eight copies of the same catalog.
  contract constant jsonb := $catalog_contract${
  "relations":{"fields":[["children","owner","parents","relation","relforcerowsecurity","relispartition","relkind","relpersistence","relrowsecurity","rules"],["children","owner","parents","relation","relforcerowsecurity","relispartition","relkind","reloptions","relpersistence","relrowsecurity","rules"]],"rows":[
    [0,[null,"$migration_owner",null,"app.album_list_item_progress",false,false,"r","p",false,null]],
    [0,[null,"$migration_owner",null,"app.album_list_items",false,false,"r","p",false,null]],
    [0,[null,"$migration_owner",null,"app.album_ratings",false,false,"r","p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_anchor",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_budget",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_checkpoint",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_run",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_session",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"app.album_top_listening_settings",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_album_metrics_state",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_history_revision",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_loss",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_capture_owner",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_decoder_observation",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_edition_capture",false,false,"r",null,"p",false,null]],
    [1,[null,"$migration_owner",null,"integration.playback_edition_selection",false,false,"r",null,"p",false,null]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7],"direct:C9":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15],"direct:CA":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15],"direct:CF":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15],"separate-owner:C0":[0,1,2,3,4,5,6,7],"separate-owner:C9":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15],"separate-owner:CA":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15],"separate-owner:CF":[0,1,2,8,9,3,4,5,10,11,12,6,7,13,14,15]}},
  "columns":{"fields":[["attgenerated","attidentity","attisdropped","attname","attnotnull","attnum","atttypmod","collation","default_acl","default_expression","relation","type"]],"rows":[
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"session_id",true,2,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"epoch",true,3,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"probe_id",true,4,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"output_frame",true,5,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"utc_lower_ms",false,6,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"utc_upper_ms",false,7,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"monotonic_probe_span_ms",true,8,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"max_quantum_frames",true,9,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"quality",true,10,-1,"\"default\"",true,null,"integration.playback_capture_anchor","text"]],
    [0,["","",false,"reservation_bytes",true,11,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","",false,"account_budget_id",false,12,-1,null,true,null,"integration.playback_capture_anchor","bigint"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_budget","bigint"]],
    [0,["","",false,"account_id",false,2,-1,null,true,null,"integration.playback_capture_budget","bigint"]],
    [0,["","",false,"is_global",true,3,-1,null,true,"false","integration.playback_capture_budget","boolean"]],
    [0,["","",false,"reserved_bytes",true,4,-1,null,true,"0","integration.playback_capture_budget","bigint"]],
    [0,["","",false,"rate_tokens",true,5,-1,null,true,"8","integration.playback_capture_budget","numeric"]],
    [0,["","",false,"rate_updated_at",true,6,-1,null,true,"now()","integration.playback_capture_budget","timestamp with time zone"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"session_id",true,2,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"sequence",true,3,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"digest",true,4,-1,"\"default\"",true,null,"integration.playback_capture_checkpoint","text"]],
    [0,["","",false,"evidence",true,5,-1,null,true,null,"integration.playback_capture_checkpoint","jsonb"]],
    [0,["","",false,"accepted_at",true,6,-1,null,true,null,"integration.playback_capture_checkpoint","timestamp with time zone"]],
    [0,["","",false,"known_frames",true,7,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"lost_frames",true,8,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"terminal",true,9,-1,null,true,null,"integration.playback_capture_checkpoint","boolean"]],
    [0,["","",false,"terminal_reason",false,10,-1,"\"default\"",true,null,"integration.playback_capture_checkpoint","text"]],
    [0,["","",false,"receipt_status",true,11,-1,null,true,null,"integration.playback_capture_checkpoint","integer"]],
    [0,["","",false,"receipt_body",true,12,-1,null,true,null,"integration.playback_capture_checkpoint","jsonb"]],
    [0,["","",false,"reservation_bytes",true,13,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","",false,"account_budget_id",false,14,-1,null,true,null,"integration.playback_capture_checkpoint","bigint"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"checkpoint_id",true,2,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"run_index",true,3,-1,null,true,null,"integration.playback_capture_run","integer"]],
    [0,["","",false,"source_start48",true,4,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"frames",true,5,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"output_start",true,6,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"ordinal_start",true,7,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"epoch",true,8,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"anchor_before",false,9,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"anchor_after",false,10,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"quality",true,11,-1,"\"default\"",true,null,"integration.playback_capture_run","text"]],
    [0,["","",false,"reservation_bytes",true,12,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"account_budget_id",false,13,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"account_id",false,2,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"library_id",true,3,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"auth_session_guard",false,4,-1,"\"default\"",true,null,"integration.playback_capture_session","text"]],
    [0,["","",false,"device_uuid",false,5,-1,null,true,null,"integration.playback_capture_session","uuid"]],
    [0,["","",false,"capture_uuid",false,6,-1,null,true,null,"integration.playback_capture_session","uuid"]],
    [0,["","",false,"v1_session_uuid",false,7,-1,null,true,null,"integration.playback_capture_session","uuid"]],
    [0,["","",false,"evidence_version",true,8,-1,"\"default\"",true,null,"integration.playback_capture_session","text"]],
    [0,["","",false,"original_track_id",true,9,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"original_file_id",true,10,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"original_root_id",true,11,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"original_album_id",false,12,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"live_track_id",false,13,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"live_album_id",false,14,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"disc_number",false,15,-1,null,true,null,"integration.playback_capture_session","integer"]],
    [0,["","",false,"track_number",false,16,-1,null,true,null,"integration.playback_capture_session","integer"]],
    [0,["","",false,"admitted_at",true,17,-1,null,true,null,"integration.playback_capture_session","timestamp with time zone"]],
    [0,["","",false,"last_activity_at",true,18,-1,null,true,null,"integration.playback_capture_session","timestamp with time zone"]],
    [0,["","",false,"last_sequence",true,19,-1,null,true,"0","integration.playback_capture_session","bigint"]],
    [0,["","",false,"accepted_known_frames",true,20,-1,null,true,"0","integration.playback_capture_session","bigint"]],
    [0,["","",false,"accepted_lost_frames",true,21,-1,null,true,"0","integration.playback_capture_session","bigint"]],
    [0,["","",false,"last_known_ordinal_end",false,22,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"last_known_output_end",false,23,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"ordinal_start",false,24,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"ordinal_end",false,25,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"terminal_at",false,26,-1,null,true,null,"integration.playback_capture_session","timestamp with time zone"]],
    [0,["","",false,"terminal_reason",false,27,-1,"\"default\"",true,null,"integration.playback_capture_session","text"]],
    [0,["","",false,"has_gaps",true,28,-1,null,true,"false","integration.playback_capture_session","boolean"]],
    [0,["","",false,"timing_unknown",true,29,-1,null,true,"false","integration.playback_capture_session","boolean"]],
    [0,["","",false,"anchor_count",true,30,-1,null,true,"0","integration.playback_capture_session","integer"]],
    [0,["","",false,"reservation_bytes",true,31,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"account_budget_id",false,32,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"listening_item_ref",false,null,-1,null,true,null,"app.album_list_item_progress","uuid"]],
    [0,["","",false,"listening_baseline_at",false,null,-1,null,true,null,"app.album_list_item_progress","timestamp with time zone"]],
    [0,["","",false,"listening_baseline_at",false,null,-1,null,true,"clock_timestamp()","app.album_list_items","timestamp with time zone"]],
    [0,["","",false,"native_rating_intent_at",false,null,-1,null,true,null,"app.album_ratings","timestamp with time zone"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"app.album_top_listening_settings","bigint"]],
    [0,["","",false,"completed_target",true,2,-1,null,false,null,"app.album_top_listening_settings","bigint"]],
    [0,["","",false,"revision",true,3,-1,null,false,null,"app.album_top_listening_settings","bigint"]],
    [0,["","",false,"created_at",true,4,-1,null,true,null,"app.album_top_listening_settings","timestamp with time zone"]],
    [0,["","",false,"updated_at",true,5,-1,null,false,null,"app.album_top_listening_settings","timestamp with time zone"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"original_library_id",true,2,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"original_album_id",true,3,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"state_revision",true,4,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"state",true,5,-1,null,true,null,"integration.playback_album_metrics_state","jsonb"]],
    [0,["","",false,"updated_at",true,6,-1,null,true,null,"integration.playback_album_metrics_state","timestamp with time zone"]],
    [0,["","",false,"reservation_bytes",true,7,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"account_budget_id",false,8,-1,null,true,null,"integration.playback_album_metrics_state","bigint"]],
    [0,["","",false,"digest",false,4,-1,"\"default\"",true,null,"integration.playback_capture_checkpoint","text"]],
    [0,["","",false,"evidence_redacted",true,15,-1,null,true,"false","integration.playback_capture_checkpoint","boolean"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"account_budget_id",false,2,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"append_revision",true,3,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"invalidation_revision",true,4,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"proof_revision",true,5,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"raw_checkpoint_cut",false,6,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","",false,"reservation_bytes",true,7,-1,null,true,null,"integration.playback_capture_history_revision","bigint"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"checkpoint_id",true,2,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"gap_index",true,3,-1,null,true,null,"integration.playback_capture_loss","integer"]],
    [0,["","",false,"owner_id",false,4,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"ordinal_start",true,5,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"ordinal_end",true,6,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"output_start",true,7,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"output_end",true,8,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"account_budget_id",false,9,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","",false,"reservation_bytes",true,10,-1,null,true,null,"integration.playback_capture_loss","bigint"]],
    [0,["","a",false,"id",true,1,-1,null,true,null,"integration.playback_capture_owner","bigint"]],
    [0,["","",false,"account_id",true,2,-1,null,true,null,"integration.playback_capture_owner","bigint"]],
    [0,["","",false,"library_id",true,3,-1,null,true,null,"integration.playback_capture_owner","bigint"]],
    [0,["","",false,"device_uuid",true,4,-1,null,true,null,"integration.playback_capture_owner","uuid"]],
    [0,["","",false,"auth_session_guard",true,5,-1,"\"default\"",true,null,"integration.playback_capture_owner","text"]],
    [0,["","",false,"owner_uuid",true,6,-1,null,true,null,"integration.playback_capture_owner","uuid"]],
    [0,["","",false,"account_budget_id",false,7,-1,null,true,null,"integration.playback_capture_owner","bigint"]],
    [0,["","",false,"reservation_bytes",true,8,-1,null,true,null,"integration.playback_capture_owner","bigint"]],
    [0,["","",false,"owner_id",false,14,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"binding_serial",false,15,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"generation",false,16,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"stream_id",false,17,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"source_base48",false,18,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"continuity_serial",false,19,-1,null,true,null,"integration.playback_capture_run","bigint"]],
    [0,["","",false,"owner_id",false,33,-1,null,true,null,"integration.playback_capture_session","bigint"]],
    [0,["","",false,"owner_uuid",false,34,-1,null,true,null,"integration.playback_capture_session","uuid"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"observation_ref",true,2,-1,null,true,null,"integration.playback_decoder_observation","uuid"]],
    [0,["","",false,"auth_session_guard",true,3,-1,"\"default\"",true,null,"integration.playback_decoder_observation","text"]],
    [0,["","",false,"original_library_id",true,4,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"original_track_id",true,5,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"original_file_id",true,6,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"original_root_id",true,7,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"generation",true,8,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"stream_id",true,9,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"source_base48",true,10,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"coordinate_basis",true,11,-1,"\"default\"",true,"'decoded-output-zero'::text","integration.playback_decoder_observation","text"]],
    [0,["","",false,"requested_start48",true,12,-1,null,true,"0","integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"extent_frames48",false,13,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"inventory_source_revision",true,14,-1,"\"default\"",true,null,"integration.playback_decoder_observation","text"]],
    [0,["","",false,"observed_at",true,15,-1,null,true,null,"integration.playback_decoder_observation","timestamp with time zone"]],
    [0,["","",false,"reservation_bytes",true,16,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"account_budget_id",false,17,-1,null,true,null,"integration.playback_decoder_observation","bigint"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"original_capture_session_id",true,2,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"live_capture_session_id",false,3,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"selection_ref",true,4,-1,null,true,null,"integration.playback_edition_capture","uuid"]],
    [0,["","",false,"original_track_id",true,5,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"reservation_bytes",true,6,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"account_budget_id",false,7,-1,null,true,null,"integration.playback_edition_capture","bigint"]],
    [0,["","",false,"account_id",true,1,-1,null,true,null,"integration.playback_edition_selection","bigint"]],
    [0,["","",false,"selection_ref",true,2,-1,null,true,null,"integration.playback_edition_selection","uuid"]],
    [0,["","",false,"originating_session_id",true,3,-1,null,true,null,"integration.playback_edition_selection","bigint"]],
    [0,["","",false,"original_library_id",true,4,-1,null,true,null,"integration.playback_edition_selection","bigint"]],
    [0,["","",false,"original_album_id",true,5,-1,null,true,null,"integration.playback_edition_selection","bigint"]],
    [0,["","",false,"membership_revision",true,6,-1,"\"default\"",true,null,"integration.playback_edition_selection","text"]],
    [0,["","",false,"canonical_membership",true,7,-1,"\"default\"",true,null,"integration.playback_edition_selection","text"]],
    [0,["","",false,"provenance",true,8,-1,"\"default\"",true,null,"integration.playback_edition_selection","text"]],
    [0,["","",false,"created_at",true,9,-1,null,true,null,"integration.playback_edition_selection","timestamp with time zone"]],
    [0,["","",false,"reservation_bytes",true,10,-1,null,true,null,"integration.playback_edition_selection","bigint"]],
    [0,["","",false,"account_budget_id",false,11,-1,null,true,null,"integration.playback_edition_selection","bigint"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76],"direct:C9":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163],"direct:CA":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163],"direct:CF":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76],"separate-owner:C9":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163],"separate-owner:CA":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163],"separate-owner:CF":[77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,94,22,23,24,25,26,27,28,29,30,31,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,32,33,34,35,36,37,38,39,40,41,42,43,44,121,122,123,124,125,126,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163]}},
  "constraints":{"fields":[["columns","condeferrable","condeferred","confdeltype","confmatchtype","confupdtype","conname","connoinherit","constraint_triggers","contype","convalidated","definition","foreign_relation","relation"]],"rows":[
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_anchor_account_budget_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_anchor","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_anchor","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_anchor"]],
    [0,[["quality","utc_lower_ms","utc_upper_ms","monotonic_probe_span_ms","max_quantum_frames"],false,false," "," "," ","playback_capture_anchor_check",false,null,"c",true,"CHECK ((((quality = 'unknown'::text) AND (utc_lower_ms IS NULL) AND (utc_upper_ms IS NULL)) OR ((quality = 'bounded'::text) AND (utc_lower_ms IS NOT NULL) AND (utc_upper_ms IS NOT NULL) AND (utc_lower_ms <= utc_upper_ms) AND (monotonic_probe_span_ms <= 250) AND (max_quantum_frames <= 2048))))",null,"integration.playback_capture_anchor"]],
    [0,[["epoch"],false,false," "," "," ","playback_capture_anchor_epoch_check",false,null,"c",true,"CHECK (((epoch >= 1) AND (epoch <= '9007199254740991'::bigint)))",null,"integration.playback_capture_anchor"]],
    [0,[["max_quantum_frames"],false,false," "," "," ","playback_capture_anchor_max_quantum_frames_check",false,null,"c",true,"CHECK ((max_quantum_frames > 0))",null,"integration.playback_capture_anchor"]],
    [0,[["monotonic_probe_span_ms"],false,false," "," "," ","playback_capture_anchor_monotonic_probe_span_ms_check",false,null,"c",true,"CHECK ((monotonic_probe_span_ms >= 0))",null,"integration.playback_capture_anchor"]],
    [0,[["output_frame"],false,false," "," "," ","playback_capture_anchor_output_frame_check",false,null,"c",true,"CHECK (((output_frame >= 0) AND (output_frame <= '9007199254740991'::bigint)))",null,"integration.playback_capture_anchor"]],
    [0,[["id"],false,false," "," "," ","playback_capture_anchor_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_anchor"]],
    [0,[["probe_id"],false,false," "," "," ","playback_capture_anchor_probe_id_check",false,null,"c",true,"CHECK (((probe_id >= 1) AND (probe_id <= '9007199254740991'::bigint)))",null,"integration.playback_capture_anchor"]],
    [0,[["quality"],false,false," "," "," ","playback_capture_anchor_quality_check",false,null,"c",true,"CHECK ((quality = ANY (ARRAY['unknown'::text, 'bounded'::text])))",null,"integration.playback_capture_anchor"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_anchor_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 128))",null,"integration.playback_capture_anchor"]],
    [0,[["session_id","epoch","probe_id"],false,false," "," "," ","playback_capture_anchor_session_id_epoch_probe_id_key",true,null,"u",true,"UNIQUE (session_id, epoch, probe_id)",null,"integration.playback_capture_anchor"]],
    [0,[["session_id"],false,false,"c","s","a","playback_capture_anchor_session_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_anchor","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_anchor","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false}],"f",true,"FOREIGN KEY (session_id) REFERENCES integration.playback_capture_session(id) ON DELETE CASCADE","integration.playback_capture_session","integration.playback_capture_anchor"]],
    [0,[["account_id"],false,false,"c","s","a","playback_capture_budget_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_capture_budget"]],
    [0,[["account_id"],false,false," "," "," ","playback_capture_budget_account_id_key",true,null,"u",true,"UNIQUE (account_id)",null,"integration.playback_capture_budget"]],
    [0,[["is_global","account_id"],false,false," "," "," ","playback_capture_budget_check",false,null,"c",true,"CHECK (((is_global AND (account_id IS NULL)) OR ((NOT is_global) AND (account_id IS NOT NULL))))",null,"integration.playback_capture_budget"]],
    [0,[["id"],false,false," "," "," ","playback_capture_budget_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_budget"]],
    [0,[["rate_tokens"],false,false," "," "," ","playback_capture_budget_rate_tokens_check",false,null,"c",true,"CHECK (((rate_tokens >= (0)::numeric) AND (rate_tokens <= (8)::numeric)))",null,"integration.playback_capture_budget"]],
    [0,[["reserved_bytes"],false,false," "," "," ","playback_capture_budget_reserved_bytes_check",false,null,"c",true,"CHECK ((reserved_bytes >= 0))",null,"integration.playback_capture_budget"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_checkpoint_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_checkpoint"]],
    [0,[["digest"],false,false," "," "," ","playback_capture_checkpoint_digest_check",false,null,"c",true,"CHECK ((digest ~ '^[a-f0-9]{64}$'::text))",null,"integration.playback_capture_checkpoint"]],
    [0,[["known_frames"],false,false," "," "," ","playback_capture_checkpoint_known_frames_check",false,null,"c",true,"CHECK ((known_frames >= 0))",null,"integration.playback_capture_checkpoint"]],
    [0,[["lost_frames"],false,false," "," "," ","playback_capture_checkpoint_lost_frames_check",false,null,"c",true,"CHECK ((lost_frames >= 0))",null,"integration.playback_capture_checkpoint"]],
    [0,[["id"],false,false," "," "," ","playback_capture_checkpoint_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_checkpoint"]],
    [0,[["receipt_status"],false,false," "," "," ","playback_capture_checkpoint_receipt_status_check",false,null,"c",true,"CHECK ((receipt_status = 200))",null,"integration.playback_capture_checkpoint"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_checkpoint_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes >= 192))",null,"integration.playback_capture_checkpoint"]],
    [0,[["sequence"],false,false," "," "," ","playback_capture_checkpoint_sequence_check",false,null,"c",true,"CHECK (((sequence >= 1) AND (sequence <= '9007199254740991'::bigint)))",null,"integration.playback_capture_checkpoint"]],
    [0,[["session_id"],false,false,"c","s","a","playback_capture_checkpoint_session_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false}],"f",true,"FOREIGN KEY (session_id) REFERENCES integration.playback_capture_session(id) ON DELETE CASCADE","integration.playback_capture_session","integration.playback_capture_checkpoint"]],
    [0,[["session_id","sequence"],false,false," "," "," ","playback_capture_checkpoint_session_id_sequence_key",true,null,"u",true,"UNIQUE (session_id, sequence)",null,"integration.playback_capture_checkpoint"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_run_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_run"]],
    [0,[["source_start48","frames","output_start","ordinal_start"],false,false," "," "," ","playback_capture_run_check",false,null,"c",true,"CHECK ((((source_start48 + frames) <= '9007199254740991'::bigint) AND ((output_start + frames) <= '9007199254740991'::bigint) AND ((ordinal_start + frames) <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["checkpoint_id"],false,false,"c","s","a","playback_capture_run_checkpoint_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false}],"f",true,"FOREIGN KEY (checkpoint_id) REFERENCES integration.playback_capture_checkpoint(id) ON DELETE CASCADE","integration.playback_capture_checkpoint","integration.playback_capture_run"]],
    [0,[["checkpoint_id","run_index"],false,false," "," "," ","playback_capture_run_checkpoint_id_run_index_key",true,null,"u",true,"UNIQUE (checkpoint_id, run_index)",null,"integration.playback_capture_run"]],
    [0,[["epoch"],false,false," "," "," ","playback_capture_run_epoch_check",false,null,"c",true,"CHECK (((epoch >= 1) AND (epoch <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["frames"],false,false," "," "," ","playback_capture_run_frames_check",false,null,"c",true,"CHECK (((frames >= 1) AND (frames <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["ordinal_start"],false,false," "," "," ","playback_capture_run_ordinal_start_check",false,null,"c",true,"CHECK (((ordinal_start >= 0) AND (ordinal_start <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["output_start"],false,false," "," "," ","playback_capture_run_output_start_check",false,null,"c",true,"CHECK (((output_start >= 0) AND (output_start <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["id"],false,false," "," "," ","playback_capture_run_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_run"]],
    [0,[["quality"],false,false," "," "," ","playback_capture_run_quality_check",false,null,"c",true,"CHECK ((quality = ANY (ARRAY['unknown'::text, 'bounded'::text])))",null,"integration.playback_capture_run"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_run_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 128))",null,"integration.playback_capture_run"]],
    [0,[["run_index"],false,false," "," "," ","playback_capture_run_run_index_check",false,null,"c",true,"CHECK (((run_index >= 0) AND (run_index <= 255)))",null,"integration.playback_capture_run"]],
    [0,[["source_start48"],false,false," "," "," ","playback_capture_run_source_start48_check",false,null,"c",true,"CHECK (((source_start48 >= 0) AND (source_start48 <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["accepted_known_frames"],false,false," "," "," ","playback_capture_session_accepted_known_frames_check",false,null,"c",true,"CHECK (((accepted_known_frames >= 0) AND (accepted_known_frames <= '9007199254740991'::bigint)))",null,"integration.playback_capture_session"]],
    [0,[["accepted_lost_frames"],false,false," "," "," ","playback_capture_session_accepted_lost_frames_check",false,null,"c",true,"CHECK (((accepted_lost_frames >= 0) AND (accepted_lost_frames <= '9007199254740991'::bigint)))",null,"integration.playback_capture_session"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_session_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_session"]],
    [0,[["account_id"],false,false,"n","s","a","playback_capture_session_account_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE SET NULL","app.accounts","integration.playback_capture_session"]],
    [0,[["anchor_count"],false,false," "," "," ","playback_capture_session_anchor_count_check",false,null,"c",true,"CHECK (((anchor_count >= 0) AND (anchor_count <= 17282)))",null,"integration.playback_capture_session"]],
    [0,[["account_id","auth_session_guard","device_uuid","capture_uuid","v1_session_uuid"],false,false," "," "," ","playback_capture_session_check",false,null,"c",true,"CHECK ((((account_id IS NULL) AND (auth_session_guard IS NULL) AND (device_uuid IS NULL) AND (capture_uuid IS NULL) AND (v1_session_uuid IS NULL)) OR ((account_id IS NOT NULL) AND (auth_session_guard IS NOT NULL) AND (device_uuid IS NOT NULL) AND (capture_uuid IS NOT NULL))))",null,"integration.playback_capture_session"]],
    [0,[["terminal_at","terminal_reason"],false,false," "," "," ","playback_capture_session_check1",false,null,"c",true,"CHECK ((((terminal_at IS NULL) AND (terminal_reason IS NULL)) OR ((terminal_at IS NOT NULL) AND (terminal_reason = ANY (ARRAY['ended'::text, 'stopped'::text, 'track_change'::text, 'owner_closed'::text, 'capture_limit'::text, 'transport_abandoned'::text, 'error'::text])))))",null,"integration.playback_capture_session"]],
    [0,[["evidence_version"],false,false," "," "," ","playback_capture_session_evidence_version_check",false,null,"c",true,"CHECK ((evidence_version = 'app-rendered-position-v1'::text))",null,"integration.playback_capture_session"]],
    [0,[["last_sequence"],false,false," "," "," ","playback_capture_session_last_sequence_check",false,null,"c",true,"CHECK (((last_sequence >= 0) AND (last_sequence <= '9007199254740991'::bigint)))",null,"integration.playback_capture_session"]],
    [0,[["library_id"],false,false,"c","s","a","playback_capture_session_library_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"library.libraries","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"library.libraries","deferrable":false}],"f",true,"FOREIGN KEY (library_id) REFERENCES library.libraries(id) ON DELETE CASCADE","library.libraries","integration.playback_capture_session"]],
    [0,[["live_album_id"],false,false,"n","s","a","playback_capture_session_live_album_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"library.local_albums","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"library.local_albums","deferrable":false}],"f",true,"FOREIGN KEY (live_album_id) REFERENCES library.local_albums(id) ON DELETE SET NULL","library.local_albums","integration.playback_capture_session"]],
    [0,[["live_track_id"],false,false,"n","s","a","playback_capture_session_live_track_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"library.local_tracks","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"library.local_tracks","deferrable":false}],"f",true,"FOREIGN KEY (live_track_id) REFERENCES library.local_tracks(id) ON DELETE SET NULL","library.local_tracks","integration.playback_capture_session"]],
    [0,[["id"],false,false," "," "," ","playback_capture_session_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_session"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_session_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 256))",null,"integration.playback_capture_session"]],
    [0,[["listening_item_ref","listening_baseline_at"],false,false," "," "," ","album_progress_listening_baseline_pair",false,null,"c",true,"CHECK (((listening_item_ref IS NULL) = (listening_baseline_at IS NULL)))",null,"app.album_list_item_progress"]],
    [0,[["account_id"],false,false,"r","s","a","album_top_listening_settings_account_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_restrict_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"app.album_top_listening_settings","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"app.album_top_listening_settings","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE RESTRICT","app.accounts","app.album_top_listening_settings"]],
    [0,[["updated_at","created_at"],false,false," "," "," ","album_top_listening_settings_check",false,null,"c",true,"CHECK ((isfinite(updated_at) AND (updated_at >= created_at)))",null,"app.album_top_listening_settings"]],
    [0,[["completed_target"],false,false," "," "," ","album_top_listening_settings_completed_target_check",false,null,"c",true,"CHECK (((completed_target >= 1) AND (completed_target <= '9007199254740991'::bigint)))",null,"app.album_top_listening_settings"]],
    [0,[["created_at"],false,false," "," "," ","album_top_listening_settings_created_at_check",false,null,"c",true,"CHECK (isfinite(created_at))",null,"app.album_top_listening_settings"]],
    [0,[["account_id"],false,false," "," "," ","album_top_listening_settings_pkey",true,null,"p",true,"PRIMARY KEY (account_id)",null,"app.album_top_listening_settings"]],
    [0,[["revision"],false,false," "," "," ","album_top_listening_settings_revision_check",false,null,"c",true,"CHECK ((revision > 0))",null,"app.album_top_listening_settings"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_album_metrics_state_account_budget_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_album_metrics_state","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_album_metrics_state","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_album_metrics_state"]],
    [0,[["account_id"],false,false,"c","s","a","playback_album_metrics_state_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_album_metrics_state","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_album_metrics_state","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_album_metrics_state"]],
    [0,[["account_id","original_library_id","original_album_id"],false,false," "," "," ","playback_album_metrics_state_pkey",true,null,"p",true,"PRIMARY KEY (account_id, original_library_id, original_album_id)",null,"integration.playback_album_metrics_state"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_album_metrics_state_reservation_bytes_check",false,null,"c",true,"CHECK (((reservation_bytes >= 1024) AND (reservation_bytes <= 8388608)))",null,"integration.playback_album_metrics_state"]],
    [0,[["state"],false,false," "," "," ","playback_album_metrics_state_state_check",false,null,"c",true,"CHECK (((jsonb_typeof(state) = 'object'::text) AND (octet_length((state)::text) <= 4194304)))",null,"integration.playback_album_metrics_state"]],
    [0,[["state_revision"],false,false," "," "," ","playback_album_metrics_state_state_revision_check",false,null,"c",true,"CHECK (((state_revision >= 1) AND (state_revision <= '9007199254740991'::bigint)))",null,"integration.playback_album_metrics_state"]],
    [0,[[],true,true," "," "," ","playback_capture_anchor_final",true,[{"args":"","type":21,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_anchor","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_anchor"]],
    [0,[[],true,true," "," "," ","playback_capture_checkpoint_final",true,[{"args":"","type":21,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_checkpoint","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_checkpoint"]],
    [0,[["evidence_redacted","digest","evidence","receipt_body"],false,false," "," "," ","playback_capture_checkpoint_redaction_check",false,null,"c",true,"CHECK ((((NOT evidence_redacted) AND (digest IS NOT NULL)) OR (evidence_redacted AND (digest IS NULL) AND (NOT (evidence ? 'owner_uuid'::text)) AND (NOT (receipt_body ? 'digest'::text)))))",null,"integration.playback_capture_checkpoint"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_history_revision_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_history_revision","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_history_revision","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_history_revision"]],
    [0,[["account_id"],false,false,"c","s","a","playback_capture_history_revision_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_history_revision","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_history_revision","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_capture_history_revision"]],
    [0,[["append_revision"],false,false," "," "," ","playback_capture_history_revision_append_revision_check",false,null,"c",true,"CHECK ((append_revision >= 0))",null,"integration.playback_capture_history_revision"]],
    [0,[["append_revision","raw_checkpoint_cut"],false,false," "," "," ","playback_capture_history_revision_check",false,null,"c",true,"CHECK (((append_revision = 0) = (raw_checkpoint_cut IS NULL)))",null,"integration.playback_capture_history_revision"]],
    [0,[[],true,true," "," "," ","playback_capture_history_revision_final",true,[{"args":"","type":21,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_history_check_revision()","internal":false,"relation":"integration.playback_capture_history_revision","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_history_revision"]],
    [0,[["invalidation_revision"],false,false," "," "," ","playback_capture_history_revision_invalidation_revision_check",false,null,"c",true,"CHECK ((invalidation_revision >= 0))",null,"integration.playback_capture_history_revision"]],
    [0,[["account_id"],false,false," "," "," ","playback_capture_history_revision_pkey",true,null,"p",true,"PRIMARY KEY (account_id)",null,"integration.playback_capture_history_revision"]],
    [0,[["proof_revision"],false,false," "," "," ","playback_capture_history_revision_proof_revision_check",false,null,"c",true,"CHECK ((proof_revision >= 0))",null,"integration.playback_capture_history_revision"]],
    [0,[["raw_checkpoint_cut"],false,false," "," "," ","playback_capture_history_revision_raw_checkpoint_cut_check",false,null,"c",true,"CHECK ((raw_checkpoint_cut > 0))",null,"integration.playback_capture_history_revision"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_history_revision_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 1024))",null,"integration.playback_capture_history_revision"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_loss_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_loss"]],
    [0,[["ordinal_end","ordinal_start","output_end","output_start"],false,false," "," "," ","playback_capture_loss_check",false,null,"c",true,"CHECK (((ordinal_end > ordinal_start) AND (output_end > output_start)))",null,"integration.playback_capture_loss"]],
    [0,[["checkpoint_id"],false,false,"c","s","a","playback_capture_loss_checkpoint_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_checkpoint","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false}],"f",true,"FOREIGN KEY (checkpoint_id) REFERENCES integration.playback_capture_checkpoint(id) ON DELETE CASCADE","integration.playback_capture_checkpoint","integration.playback_capture_loss"]],
    [0,[["checkpoint_id","gap_index"],false,false," "," "," ","playback_capture_loss_checkpoint_id_gap_index_key",true,null,"u",true,"UNIQUE (checkpoint_id, gap_index)",null,"integration.playback_capture_loss"]],
    [0,[[],true,true," "," "," ","playback_capture_loss_final",true,[{"args":"","type":29,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_loss","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_loss"]],
    [0,[["gap_index"],false,false," "," "," ","playback_capture_loss_gap_index_check",false,null,"c",true,"CHECK (((gap_index >= 0) AND (gap_index <= 7)))",null,"integration.playback_capture_loss"]],
    [0,[["ordinal_end"],false,false," "," "," ","playback_capture_loss_ordinal_end_check",false,null,"c",true,"CHECK (((ordinal_end >= 1) AND (ordinal_end <= '9007199254740991'::bigint)))",null,"integration.playback_capture_loss"]],
    [0,[["ordinal_start"],false,false," "," "," ","playback_capture_loss_ordinal_start_check",false,null,"c",true,"CHECK (((ordinal_start >= 0) AND (ordinal_start <= '9007199254740991'::bigint)))",null,"integration.playback_capture_loss"]],
    [0,[["output_end"],false,false," "," "," ","playback_capture_loss_output_end_check",false,null,"c",true,"CHECK (((output_end >= 1) AND (output_end <= '9007199254740991'::bigint)))",null,"integration.playback_capture_loss"]],
    [0,[["output_start"],false,false," "," "," ","playback_capture_loss_output_start_check",false,null,"c",true,"CHECK (((output_start >= 0) AND (output_start <= '9007199254740991'::bigint)))",null,"integration.playback_capture_loss"]],
    [0,[["owner_id"],false,false,"n","s","a","playback_capture_loss_owner_id_fkey",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_loss","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false}],"f",true,"FOREIGN KEY (owner_id) REFERENCES integration.playback_capture_owner(id) ON DELETE SET NULL","integration.playback_capture_owner","integration.playback_capture_loss"]],
    [0,[["id"],false,false," "," "," ","playback_capture_loss_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_loss"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_loss_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 384))",null,"integration.playback_capture_loss"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_capture_owner_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_capture_owner"]],
    [0,[["account_id"],false,false,"c","s","a","playback_capture_owner_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_capture_owner"]],
    [0,[["account_id","library_id","device_uuid","auth_session_guard","owner_uuid"],false,false," "," "," ","playback_capture_owner_account_id_library_id_device_uuid_au_key",true,null,"u",true,"UNIQUE (account_id, library_id, device_uuid, auth_session_guard, owner_uuid)",null,"integration.playback_capture_owner"]],
    [0,[["auth_session_guard"],false,false," "," "," ","playback_capture_owner_auth_session_guard_check",false,null,"c",true,"CHECK (((octet_length(auth_session_guard) >= 1) AND (octet_length(auth_session_guard) <= 256)))",null,"integration.playback_capture_owner"]],
    [0,[[],true,true," "," "," ","playback_capture_owner_final",true,[{"args":"","type":29,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_owner","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_owner"]],
    [0,[["id"],false,false," "," "," ","playback_capture_owner_id_check",false,null,"c",true,"CHECK (((id >= 1) AND (id <= '9007199254740991'::bigint)))",null,"integration.playback_capture_owner"]],
    [0,[["owner_uuid"],false,false," "," "," ","playback_capture_owner_owner_uuid_check",false,null,"c",true,"CHECK ((owner_uuid <> '00000000-0000-0000-0000-000000000000'::uuid))",null,"integration.playback_capture_owner"]],
    [0,[["id"],false,false," "," "," ","playback_capture_owner_pkey",true,null,"p",true,"PRIMARY KEY (id)",null,"integration.playback_capture_owner"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_owner_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 1024))",null,"integration.playback_capture_owner"]],
    [0,[["binding_serial"],false,false," "," "," ","playback_capture_run_binding_serial_check",false,null,"c",true,"CHECK (((binding_serial >= 1) AND (binding_serial <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_capture_run_charge_check",false,null,"c",true,"CHECK ((reservation_bytes = ANY (ARRAY[(128)::bigint, (320)::bigint])))",null,"integration.playback_capture_run"]],
    [0,[["continuity_serial"],false,false," "," "," ","playback_capture_run_continuity_serial_check",false,null,"c",true,"CHECK (((continuity_serial >= 1) AND (continuity_serial <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[[],true,true," "," "," ","playback_capture_run_final",true,[{"args":"","type":21,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_run","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_run"]],
    [0,[["generation"],false,false," "," "," ","playback_capture_run_generation_check",false,null,"c",true,"CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["owner_id"],false,false,"n","s","a","playback_capture_run_owner_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_run","deferrable":false}],"f",true,"FOREIGN KEY (owner_id) REFERENCES integration.playback_capture_owner(id) ON DELETE SET NULL","integration.playback_capture_owner","integration.playback_capture_run"]],
    [0,[["source_base48"],false,false," "," "," ","playback_capture_run_source_base48_check",false,null,"c",true,"CHECK (((source_base48 >= 0) AND (source_base48 <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[["stream_id"],false,false," "," "," ","playback_capture_run_stream_id_check",false,null,"c",true,"CHECK (((stream_id >= 1) AND (stream_id <= '9007199254740991'::bigint)))",null,"integration.playback_capture_run"]],
    [0,[[],true,true," "," "," ","playback_capture_owner_cleanup",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_cleanup_owner()","internal":false,"relation":"integration.playback_capture_session","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_session"]],
    [0,[["evidence_version","reservation_bytes"],false,false," "," "," ","playback_capture_session_charge_check",false,null,"c",true,"CHECK ((((evidence_version = 'app-rendered-position-v1'::text) AND (reservation_bytes = 256)) OR ((evidence_version = 'app-rendered-position-v2'::text) AND (reservation_bytes = 384))))",null,"integration.playback_capture_session"]],
    [0,[[],true,true," "," "," ","playback_capture_session_final",true,[{"args":"","type":21,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_capture_v2_check_graph()","internal":false,"relation":"integration.playback_capture_session","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_capture_session"]],
    [0,[["owner_id"],false,false,"n","s","a","playback_capture_session_owner_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_owner","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false}],"f",true,"FOREIGN KEY (owner_id) REFERENCES integration.playback_capture_owner(id) ON DELETE SET NULL","integration.playback_capture_owner","integration.playback_capture_session"]],
    [0,[["evidence_version"],false,false," "," "," ","playback_capture_session_version_check",false,null,"c",true,"CHECK ((evidence_version = ANY (ARRAY['app-rendered-position-v1'::text, 'app-rendered-position-v2'::text])))",null,"integration.playback_capture_session"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_decoder_observation_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_decoder_observation","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_decoder_observation","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_decoder_observation"]],
    [0,[["account_id"],false,false,"c","s","a","playback_decoder_observation_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_decoder_observation","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_decoder_observation","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_decoder_observation"]],
    [0,[["auth_session_guard"],false,false," "," "," ","playback_decoder_observation_auth_session_guard_check",false,null,"c",true,"CHECK (((length(auth_session_guard) >= 1) AND (length(auth_session_guard) <= 256)))",null,"integration.playback_decoder_observation"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_check",false,null,"c",true,"CHECK ((((coordinate_basis = 'decoded-output-zero'::text) AND (requested_start48 = 0)) OR ((coordinate_basis = 'decoded-output-local'::text) AND (requested_start48 > 0))))",null,"integration.playback_decoder_observation"]],
    [0,[["extent_frames48"],false,false," "," "," ","playback_decoder_observation_extent_frames48_check",false,null,"c",true,"CHECK (((extent_frames48 >= 1) AND (extent_frames48 <= '9007199254740991'::bigint)))",null,"integration.playback_decoder_observation"]],
    [0,[["generation"],false,false," "," "," ","playback_decoder_observation_generation_check",false,null,"c",true,"CHECK (((generation >= 1) AND (generation <= 2147483647)))",null,"integration.playback_decoder_observation"]],
    [0,[["inventory_source_revision"],false,false," "," "," ","playback_decoder_observation_inventory_source_revision_check",false,null,"c",true,"CHECK ((inventory_source_revision ~ '^[a-f0-9]{64}$'::text))",null,"integration.playback_decoder_observation"]],
    [0,[["original_file_id"],false,false," "," "," ","playback_decoder_observation_original_file_id_check",false,null,"c",true,"CHECK ((original_file_id > 0))",null,"integration.playback_decoder_observation"]],
    [0,[["original_library_id"],false,false," "," "," ","playback_decoder_observation_original_library_id_check",false,null,"c",true,"CHECK ((original_library_id > 0))",null,"integration.playback_decoder_observation"]],
    [0,[["original_root_id"],false,false," "," "," ","playback_decoder_observation_original_root_id_check",false,null,"c",true,"CHECK ((original_root_id > 0))",null,"integration.playback_decoder_observation"]],
    [0,[["original_track_id"],false,false," "," "," ","playback_decoder_observation_original_track_id_check",false,null,"c",true,"CHECK ((original_track_id > 0))",null,"integration.playback_decoder_observation"]],
    [0,[["account_id","observation_ref"],false,false," "," "," ","playback_decoder_observation_pkey",true,null,"p",true,"PRIMARY KEY (account_id, observation_ref)",null,"integration.playback_decoder_observation"]],
    [0,[["requested_start48"],false,false," "," "," ","playback_decoder_observation_requested_start48_check",false,null,"c",true,"CHECK (((requested_start48 >= 0) AND (requested_start48 <= '9007199254740991'::bigint)))",null,"integration.playback_decoder_observation"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_decoder_observation_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 512))",null,"integration.playback_decoder_observation"]],
    [0,[["source_base48"],false,false," "," "," ","playback_decoder_observation_source_base48_check",false,null,"c",true,"CHECK ((source_base48 = 0))",null,"integration.playback_decoder_observation"]],
    [0,[["stream_id"],false,false," "," "," ","playback_decoder_observation_stream_id_check",false,null,"c",true,"CHECK (((stream_id >= 1) AND (stream_id <= 2147483647)))",null,"integration.playback_decoder_observation"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_edition_capture_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_edition_capture"]],
    [0,[["account_id"],false,false,"c","s","a","playback_edition_capture_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_edition_capture"]],
    [0,[["live_capture_session_id","original_capture_session_id"],false,false," "," "," ","playback_edition_capture_check",false,null,"c",true,"CHECK (((live_capture_session_id IS NULL) OR (live_capture_session_id = original_capture_session_id)))",null,"integration.playback_edition_capture"]],
    [0,[[],true,true," "," "," ","playback_edition_capture_guard",true,[{"args":"","type":29,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_edition_guard()","internal":false,"relation":"integration.playback_edition_capture","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_edition_capture"]],
    [0,[["live_capture_session_id"],false,false,"n","s","a","playback_edition_capture_live_capture_session_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_session","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false}],"f",true,"FOREIGN KEY (live_capture_session_id) REFERENCES integration.playback_capture_session(id) ON DELETE SET NULL","integration.playback_capture_session","integration.playback_edition_capture"]],
    [0,[["original_capture_session_id"],false,false," "," "," ","playback_edition_capture_original_capture_session_id_check",false,null,"c",true,"CHECK ((original_capture_session_id > 0))",null,"integration.playback_edition_capture"]],
    [0,[["original_track_id"],false,false," "," "," ","playback_edition_capture_original_track_id_check",false,null,"c",true,"CHECK ((original_track_id > 0))",null,"integration.playback_edition_capture"]],
    [0,[["account_id","original_capture_session_id"],false,false," "," "," ","playback_edition_capture_pkey",true,null,"p",true,"PRIMARY KEY (account_id, original_capture_session_id)",null,"integration.playback_edition_capture"]],
    [0,[["reservation_bytes"],false,false," "," "," ","playback_edition_capture_reservation_bytes_check",false,null,"c",true,"CHECK ((reservation_bytes = 512))",null,"integration.playback_edition_capture"]],
    [0,[["account_id","selection_ref"],false,false,"a","s","a","playback_edition_capture_selection",true,[{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_capture","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_del\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false}],"f",true,"FOREIGN KEY (account_id, selection_ref) REFERENCES integration.playback_edition_selection(account_id, selection_ref)","integration.playback_edition_selection","integration.playback_edition_capture"]],
    [0,[["account_budget_id"],false,false,"n","s","a","playback_edition_selection_account_budget_id_fkey",true,[{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_setnull_del\"()","internal":true,"relation":"integration.playback_capture_budget","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false}],"f",true,"FOREIGN KEY (account_budget_id) REFERENCES integration.playback_capture_budget(id) ON DELETE SET NULL","integration.playback_capture_budget","integration.playback_edition_selection"]],
    [0,[["account_id"],false,false,"c","s","a","playback_edition_selection_account_id_fkey",true,[{"args":"","type":9,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_cascade_del\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_noaction_upd\"()","internal":true,"relation":"app.accounts","deferrable":false},{"args":"","type":5,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_ins\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false},{"args":"","type":17,"when":null,"enabled":"O","deferred":false,"function":"\"RI_FKey_check_upd\"()","internal":true,"relation":"integration.playback_edition_selection","deferrable":false}],"f",true,"FOREIGN KEY (account_id) REFERENCES app.accounts(id) ON DELETE CASCADE","app.accounts","integration.playback_edition_selection"]],
    [0,[["canonical_membership","reservation_bytes","provenance"],false,false," "," "," ","playback_edition_selection_body",false,null,"c",true,"CHECK ((((octet_length(canonical_membership) >= 1) AND (octet_length(canonical_membership) <= 262144)) AND (reservation_bytes = ((2048 + octet_length(canonical_membership)) + octet_length(provenance)))))",null,"integration.playback_edition_selection"]],
    [0,[[],true,true," "," "," ","playback_edition_selection_guard",true,[{"args":"","type":29,"when":null,"enabled":"O","deferred":true,"function":"integration.playback_edition_guard()","internal":false,"relation":"integration.playback_edition_selection","deferrable":true}],"t",true,"TRIGGER DEFERRABLE INITIALLY DEFERRED",null,"integration.playback_edition_selection"]],
    [0,[["membership_revision"],false,false," "," "," ","playback_edition_selection_membership_revision_check",false,null,"c",true,"CHECK ((membership_revision ~ '^[0-9a-f]{64}$'::text))",null,"integration.playback_edition_selection"]],
    [0,[["original_album_id"],false,false," "," "," ","playback_edition_selection_original_album_id_check",false,null,"c",true,"CHECK ((original_album_id > 0))",null,"integration.playback_edition_selection"]],
    [0,[["original_library_id"],false,false," "," "," ","playback_edition_selection_original_library_id_check",false,null,"c",true,"CHECK ((original_library_id > 0))",null,"integration.playback_edition_selection"]],
    [0,[["originating_session_id"],false,false," "," "," ","playback_edition_selection_originating_session_id_check",false,null,"c",true,"CHECK ((originating_session_id > 0))",null,"integration.playback_edition_selection"]],
    [0,[["account_id","selection_ref"],false,false," "," "," ","playback_edition_selection_pkey",true,null,"p",true,"PRIMARY KEY (account_id, selection_ref)",null,"integration.playback_edition_selection"]],
    [0,[["provenance"],false,false," "," "," ","playback_edition_selection_provenance_check",false,null,"c",true,"CHECK ((octet_length(provenance) <= 2048))",null,"integration.playback_edition_selection"]],
    [0,[["selection_ref"],false,false," "," "," ","playback_edition_selection_selection_ref_check",false,null,"c",true,"CHECK ((selection_ref <> '00000000-0000-0000-0000-000000000000'::uuid))",null,"integration.playback_edition_selection"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_absolute_flac48_v1",false,null,"c",true,"CHECK (((coordinate_basis <> 'decoded-output-absolute-flac48'::text) OR (requested_start48 >= 0)))",null,"integration.playback_decoder_observation"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_absolute_wav48_v1",false,null,"c",true,"CHECK (((coordinate_basis <> 'decoded-output-absolute-wav48'::text) OR (requested_start48 > 0)))",null,"integration.playback_decoder_observation"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_check",false,null,"c",true,"CHECK ((((coordinate_basis = 'decoded-output-zero'::text) AND (requested_start48 = 0)) OR ((coordinate_basis = 'decoded-output-local'::text) AND (requested_start48 > 0)) OR ((coordinate_basis = 'decoded-output-absolute-wav48'::text) AND (requested_start48 > 0)) OR ((coordinate_basis = 'decoded-output-absolute-flac48'::text) AND (requested_start48 >= 0))))",null,"integration.playback_decoder_observation"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_check",false,null,"c",true,"CHECK ((((coordinate_basis = 'decoded-output-zero'::text) AND (requested_start48 = 0)) OR ((coordinate_basis = 'decoded-output-local'::text) AND (requested_start48 > 0)) OR ((coordinate_basis = 'decoded-output-absolute-wav48'::text) AND (requested_start48 > 0)) OR ((coordinate_basis = 'decoded-output-absolute-flac48'::text) AND (requested_start48 >= 0)) OR ((coordinate_basis = 'decoded-output-flac441-swr48-v1'::text) AND (requested_start48 >= 0) AND (requested_start48 < '137438953472'::bigint))))",null,"integration.playback_decoder_observation"]],
    [0,[["coordinate_basis","requested_start48"],false,false," "," "," ","playback_decoder_observation_flac441_swr48_v1",false,null,"c",true,"CHECK (((coordinate_basis <> 'decoded-output-flac441-swr48-v1'::text) OR ((requested_start48 >= 0) AND (requested_start48 < '137438953472'::bigint))))",null,"integration.playback_decoder_observation"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54],"direct:C9":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152],"direct:CA":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,153,154,116,117,118,155,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152],"direct:CF":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,153,154,116,117,118,156,120,157,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54],"separate-owner:C9":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152],"separate-owner:CA":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,153,154,116,117,118,155,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152],"separate-owner:CF":[55,56,57,58,59,60,61,62,63,64,65,66,67,0,1,2,68,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,69,20,21,22,23,70,24,25,26,27,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,28,103,104,29,30,31,105,32,106,33,107,34,35,108,36,37,39,109,40,110,111,41,42,43,44,45,112,46,47,113,49,51,52,114,53,115,153,154,116,117,118,156,120,157,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152]}},
  "indexes":{"fields":[["columns","definition","dependent_columns","indimmediate","indisexclusion","indislive","indisprimary","indisready","indisunique","indisvalid","indnullsnotdistinct","owner","relation","relkind","relname","reloptions","relpersistence"]],"rows":[
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_anchor_pkey ON integration.playback_capture_anchor USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_anchor","i","playback_capture_anchor_pkey",null,"p"]],
    [0,[["session_id","epoch","probe_id"],"CREATE UNIQUE INDEX playback_capture_anchor_session_id_epoch_probe_id_key ON integration.playback_capture_anchor USING btree (session_id, epoch, probe_id)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_anchor","i","playback_capture_anchor_session_id_epoch_probe_id_key",null,"p"]],
    [0,[["account_id"],"CREATE UNIQUE INDEX playback_capture_budget_account_id_key ON integration.playback_capture_budget USING btree (account_id)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_budget","i","playback_capture_budget_account_id_key",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_budget_pkey ON integration.playback_capture_budget USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_budget","i","playback_capture_budget_pkey",null,"p"]],
    [0,[["is_global"],"CREATE UNIQUE INDEX playback_capture_one_global_budget ON integration.playback_capture_budget USING btree (is_global) WHERE is_global",["is_global"],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_budget","i","playback_capture_one_global_budget",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_checkpoint_pkey ON integration.playback_capture_checkpoint USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_checkpoint","i","playback_capture_checkpoint_pkey",null,"p"]],
    [0,[["session_id","sequence"],"CREATE UNIQUE INDEX playback_capture_checkpoint_session_id_sequence_key ON integration.playback_capture_checkpoint USING btree (session_id, sequence)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_checkpoint","i","playback_capture_checkpoint_session_id_sequence_key",null,"p"]],
    [0,[["checkpoint_id","run_index"],"CREATE UNIQUE INDEX playback_capture_run_checkpoint_id_run_index_key ON integration.playback_capture_run USING btree (checkpoint_id, run_index)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_run","i","playback_capture_run_checkpoint_id_run_index_key",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_run_pkey ON integration.playback_capture_run USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_run","i","playback_capture_run_pkey",null,"p"]],
    [0,[["account_id","last_activity_at"],"CREATE INDEX playback_capture_active_owner ON integration.playback_capture_session USING btree (account_id, last_activity_at) WHERE (terminal_at IS NULL)",["account_id","last_activity_at","terminal_at"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_active_owner",null,"p"]],
    [0,[["account_id","device_uuid","capture_uuid"],"CREATE UNIQUE INDEX playback_capture_owned_identity ON integration.playback_capture_session USING btree (account_id, device_uuid, capture_uuid) WHERE (account_id IS NOT NULL)",["account_id","capture_uuid","device_uuid"],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_owned_identity",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_session_pkey ON integration.playback_capture_session USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_session_pkey",null,"p"]],
    [0,[["account_id"],"CREATE UNIQUE INDEX album_top_listening_settings_pkey ON app.album_top_listening_settings USING btree (account_id)",[],true,false,true,true,true,true,true,false,"$migration_owner","app.album_top_listening_settings","i","album_top_listening_settings_pkey",null,"p"]],
    [0,[["account_id","original_library_id","original_album_id"],"CREATE UNIQUE INDEX playback_album_metrics_state_pkey ON integration.playback_album_metrics_state USING btree (account_id, original_library_id, original_album_id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_album_metrics_state","i","playback_album_metrics_state_pkey",null,"p"]],
    [0,[["account_budget_id"],"CREATE INDEX playback_capture_history_revision_budget_ref ON integration.playback_capture_history_revision USING btree (account_budget_id) WHERE (account_budget_id IS NOT NULL)",["account_budget_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_history_revision","i","playback_capture_history_revision_budget_ref",null,"p"]],
    [0,[["account_id"],"CREATE UNIQUE INDEX playback_capture_history_revision_pkey ON integration.playback_capture_history_revision USING btree (account_id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_history_revision","i","playback_capture_history_revision_pkey",null,"p"]],
    [0,[["account_budget_id"],"CREATE INDEX playback_capture_loss_budget_ref ON integration.playback_capture_loss USING btree (account_budget_id) WHERE (account_budget_id IS NOT NULL)",["account_budget_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_budget_ref",null,"p"]],
    [0,[["checkpoint_id","gap_index"],"CREATE UNIQUE INDEX playback_capture_loss_checkpoint_id_gap_index_key ON integration.playback_capture_loss USING btree (checkpoint_id, gap_index)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_checkpoint_id_gap_index_key",null,"p"]],
    [0,[[],"CREATE INDEX playback_capture_loss_owner_ordinal_range ON integration.playback_capture_loss USING gist (int8range(owner_id, owner_id, '[]'::text), int8range(ordinal_start, ordinal_end, '[)'::text)) WHERE (owner_id IS NOT NULL)",["ordinal_end","ordinal_start","owner_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_owner_ordinal_range",null,"p"]],
    [0,[[],"CREATE INDEX playback_capture_loss_owner_output_range ON integration.playback_capture_loss USING gist (int8range(owner_id, owner_id, '[]'::text), int8range(output_start, output_end, '[)'::text)) WHERE (owner_id IS NOT NULL)",["output_end","output_start","owner_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_owner_output_range",null,"p"]],
    [0,[["owner_id"],"CREATE INDEX playback_capture_loss_owner_ref ON integration.playback_capture_loss USING btree (owner_id) WHERE (owner_id IS NOT NULL)",["owner_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_owner_ref",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_loss_pkey ON integration.playback_capture_loss USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_loss","i","playback_capture_loss_pkey",null,"p"]],
    [0,[["account_id","library_id","device_uuid","auth_session_guard","owner_uuid"],"CREATE UNIQUE INDEX playback_capture_owner_account_id_library_id_device_uuid_au_key ON integration.playback_capture_owner USING btree (account_id, library_id, device_uuid, auth_session_guard, owner_uuid)",[],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_owner","i","playback_capture_owner_account_id_library_id_device_uuid_au_key",null,"p"]],
    [0,[["account_id","library_id","id"],"CREATE INDEX playback_capture_owner_local_metrics_page ON integration.playback_capture_owner USING btree (account_id, library_id, id)",["account_id","id","library_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_owner","i","playback_capture_owner_local_metrics_page",null,"p"]],
    [0,[["id"],"CREATE UNIQUE INDEX playback_capture_owner_pkey ON integration.playback_capture_owner USING btree (id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_capture_owner","i","playback_capture_owner_pkey",null,"p"]],
    [0,[["owner_id","binding_serial"],"CREATE INDEX playback_capture_run_owner_binding ON integration.playback_capture_run USING btree (owner_id, binding_serial) WHERE (owner_id IS NOT NULL)",["binding_serial","owner_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_run","i","playback_capture_run_owner_binding",null,"p"]],
    [0,[["owner_id","ordinal_start"],"CREATE UNIQUE INDEX playback_capture_run_owner_ordinal ON integration.playback_capture_run USING btree (owner_id, ordinal_start) WHERE (owner_id IS NOT NULL)",["ordinal_start","owner_id"],true,false,true,false,true,true,true,false,"$migration_owner","integration.playback_capture_run","i","playback_capture_run_owner_ordinal",null,"p"]],
    [0,[["account_id","evidence_version","id"],"CREATE INDEX playback_capture_account_session_history ON integration.playback_capture_session USING btree (account_id, evidence_version, id)",["account_id","evidence_version","id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_account_session_history",null,"p"]],
    [0,[["account_id","library_id","original_album_id","id"],"CREATE INDEX playback_capture_session_local_album ON integration.playback_capture_session USING btree (account_id, library_id, original_album_id, id)",["account_id","id","library_id","original_album_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_session_local_album",null,"p"]],
    [0,[["owner_id"],"CREATE INDEX playback_capture_session_owner_ref ON integration.playback_capture_session USING btree (owner_id) WHERE (owner_id IS NOT NULL)",["owner_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_capture_session","i","playback_capture_session_owner_ref",null,"p"]],
    [0,[["account_id","original_library_id","original_file_id","inventory_source_revision","coordinate_basis","extent_frames48"],"CREATE INDEX playback_decoder_observation_local_version_extent ON integration.playback_decoder_observation USING btree (account_id, original_library_id, original_file_id, inventory_source_revision, coordinate_basis, extent_frames48) WHERE (extent_frames48 IS NOT NULL)",["account_id","coordinate_basis","extent_frames48","inventory_source_revision","original_file_id","original_library_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_decoder_observation","i","playback_decoder_observation_local_version_extent",null,"p"]],
    [0,[["account_id","observation_ref"],"CREATE UNIQUE INDEX playback_decoder_observation_pkey ON integration.playback_decoder_observation USING btree (account_id, observation_ref)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_decoder_observation","i","playback_decoder_observation_pkey",null,"p"]],
    [0,[["account_budget_id"],"CREATE INDEX playback_edition_capture_budget ON integration.playback_edition_capture USING btree (account_budget_id) WHERE (account_budget_id IS NOT NULL)",["account_budget_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_edition_capture","i","playback_edition_capture_budget",null,"p"]],
    [0,[["live_capture_session_id"],"CREATE INDEX playback_edition_capture_live ON integration.playback_edition_capture USING btree (live_capture_session_id) WHERE (live_capture_session_id IS NOT NULL)",["live_capture_session_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_edition_capture","i","playback_edition_capture_live",null,"p"]],
    [0,[["account_id","original_capture_session_id"],"CREATE UNIQUE INDEX playback_edition_capture_pkey ON integration.playback_edition_capture USING btree (account_id, original_capture_session_id)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_edition_capture","i","playback_edition_capture_pkey",null,"p"]],
    [0,[["account_id","selection_ref"],"CREATE INDEX playback_edition_capture_selection_ref ON integration.playback_edition_capture USING btree (account_id, selection_ref)",["account_id","selection_ref"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_edition_capture","i","playback_edition_capture_selection_ref",null,"p"]],
    [0,[["account_budget_id"],"CREATE INDEX playback_edition_selection_budget ON integration.playback_edition_selection USING btree (account_budget_id) WHERE (account_budget_id IS NOT NULL)",["account_budget_id"],true,false,true,false,true,false,true,false,"$migration_owner","integration.playback_edition_selection","i","playback_edition_selection_budget",null,"p"]],
    [0,[["account_id","selection_ref"],"CREATE UNIQUE INDEX playback_edition_selection_pkey ON integration.playback_edition_selection USING btree (account_id, selection_ref)",[],true,false,true,true,true,true,true,false,"$migration_owner","integration.playback_edition_selection","i","playback_edition_selection_pkey",null,"p"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11],"direct:C9":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37],"direct:CA":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37],"direct:CF":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11],"separate-owner:C9":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37],"separate-owner:CA":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37],"separate-owner:CF":[12,13,0,1,2,3,4,5,6,14,15,16,17,18,19,20,21,22,23,24,7,25,26,8,27,9,10,28,29,11,30,31,32,33,34,35,36,37]}},
  "triggers":{"fields":[["args","columns","condition","definition","function","relation","tgdeferrable","tgenabled","tginitdeferred","tgname","tgtype"]],"rows":[
    [0,["",[],null,"CREATE TRIGGER album_top_source_structure_guard BEFORE INSERT OR DELETE OR UPDATE ON app.album_list_items FOR EACH ROW EXECUTE FUNCTION app.guard_album_top_source_structure()","app.guard_album_top_source_structure()","app.album_list_items",false,"O",false,"album_top_source_structure_guard",31]],
    [0,["",[],null,"CREATE TRIGGER artwork_publication_closure BEFORE INSERT OR DELETE OR UPDATE ON app.album_list_items FOR EACH ROW EXECUTE FUNCTION app._artwork_publication_closure_guard()","app._artwork_publication_closure_guard()","app.album_list_items",false,"O",false,"artwork_publication_closure",31]],
    [0,["",[],null,"CREATE TRIGGER home_album_taste_change AFTER INSERT OR DELETE OR UPDATE ON app.album_ratings FOR EACH ROW EXECUTE FUNCTION app.invalidate_home_album_taste()","app.invalidate_home_album_taste()","app.album_ratings",false,"O",false,"home_album_taste_change",29]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_anchor_release AFTER DELETE ON integration.playback_capture_anchor FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_anchor",false,"O",false,"playback_capture_anchor_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_checkpoint_release AFTER DELETE ON integration.playback_capture_checkpoint FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_checkpoint",false,"O",false,"playback_capture_checkpoint_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_run_release AFTER DELETE ON integration.playback_capture_run FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_run",false,"O",false,"playback_capture_run_release",9]],
    [0,["",["account_id"],null,"CREATE TRIGGER playback_capture_anonymize_owner BEFORE UPDATE OF account_id ON integration.playback_capture_session FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_anonymize()","integration.playback_capture_anonymize()","integration.playback_capture_session",false,"O",false,"playback_capture_anonymize_owner",19]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_session_release AFTER DELETE ON integration.playback_capture_session FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_session",false,"O",false,"playback_capture_session_release",9]],
    [0,["",[],null,"CREATE TRIGGER album_top_listening_settings_update BEFORE UPDATE ON app.album_top_listening_settings FOR EACH ROW EXECUTE FUNCTION app.guard_album_top_listening_settings()","app.guard_album_top_listening_settings()","app.album_top_listening_settings",false,"O",false,"album_top_listening_settings_update",19]],
    [0,["",[],null,"CREATE TRIGGER playback_album_metrics_state_guard BEFORE INSERT OR UPDATE ON integration.playback_album_metrics_state FOR EACH ROW EXECUTE FUNCTION integration.playback_album_metrics_state_guard()","integration.playback_album_metrics_state_guard()","integration.playback_album_metrics_state",false,"O",false,"playback_album_metrics_state_guard",23]],
    [0,["",[],null,"CREATE TRIGGER playback_album_metrics_state_release AFTER DELETE ON integration.playback_album_metrics_state FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_album_metrics_state",false,"O",false,"playback_album_metrics_state_release",9]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_anchor_final AFTER INSERT OR UPDATE ON integration.playback_capture_anchor DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_anchor",true,"O",true,"playback_capture_anchor_final",21]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_anchor BEFORE DELETE OR UPDATE ON integration.playback_capture_anchor FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_anchor",false,"O",false,"playback_capture_history_anchor",27]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_checkpoint_final AFTER INSERT OR UPDATE ON integration.playback_capture_checkpoint DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_checkpoint",true,"O",true,"playback_capture_checkpoint_final",21]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_checkpoint BEFORE DELETE OR UPDATE ON integration.playback_capture_checkpoint FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_checkpoint",false,"O",false,"playback_capture_history_checkpoint",27]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_v2_checkpoint_immutable BEFORE UPDATE ON integration.playback_capture_checkpoint FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_guard_checkpoint()","integration.playback_capture_v2_guard_checkpoint()","integration.playback_capture_checkpoint",false,"O",false,"playback_capture_v2_checkpoint_immutable",19]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_history_revision_final AFTER INSERT OR UPDATE ON integration.playback_capture_history_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_check_revision()","integration.playback_capture_history_check_revision()","integration.playback_capture_history_revision",true,"O",true,"playback_capture_history_revision_final",21]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_revision_guard BEFORE DELETE OR UPDATE ON integration.playback_capture_history_revision FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_guard_revision()","integration.playback_capture_history_guard_revision()","integration.playback_capture_history_revision",false,"O",false,"playback_capture_history_revision_guard",27]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_revision_release AFTER DELETE ON integration.playback_capture_history_revision FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_history_revision",false,"O",false,"playback_capture_history_revision_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_loss BEFORE DELETE OR UPDATE ON integration.playback_capture_loss FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_loss",false,"O",false,"playback_capture_history_loss",27]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_loss_final AFTER INSERT OR DELETE OR UPDATE ON integration.playback_capture_loss DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_loss",true,"O",true,"playback_capture_loss_final",29]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_loss_release AFTER DELETE ON integration.playback_capture_loss FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_loss",false,"O",false,"playback_capture_loss_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_owner BEFORE DELETE OR UPDATE ON integration.playback_capture_owner FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_owner",false,"O",false,"playback_capture_history_owner",27]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_owner_final AFTER INSERT OR DELETE OR UPDATE ON integration.playback_capture_owner DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_owner",true,"O",true,"playback_capture_owner_final",29]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_owner_immutable BEFORE UPDATE ON integration.playback_capture_owner FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_guard_owner()","integration.playback_capture_v2_guard_owner()","integration.playback_capture_owner",false,"O",false,"playback_capture_owner_immutable",19]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_owner_release AFTER DELETE ON integration.playback_capture_owner FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_capture_owner",false,"O",false,"playback_capture_owner_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_run BEFORE DELETE OR UPDATE ON integration.playback_capture_run FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_run",false,"O",false,"playback_capture_history_run",27]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_run_final AFTER INSERT OR UPDATE ON integration.playback_capture_run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_run",true,"O",true,"playback_capture_run_final",21]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_history_session BEFORE DELETE OR UPDATE ON integration.playback_capture_session FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_history_raw_mutation()","integration.playback_capture_history_raw_mutation()","integration.playback_capture_session",false,"O",false,"playback_capture_history_session",27]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_owner_cleanup AFTER DELETE ON integration.playback_capture_session DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_cleanup_owner()","integration.playback_capture_v2_cleanup_owner()","integration.playback_capture_session",true,"O",true,"playback_capture_owner_cleanup",9]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_capture_session_final AFTER INSERT OR UPDATE ON integration.playback_capture_session DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_check_graph()","integration.playback_capture_v2_check_graph()","integration.playback_capture_session",true,"O",true,"playback_capture_session_final",21]],
    [0,["",[],null,"CREATE TRIGGER playback_capture_v2_session_guard BEFORE INSERT OR UPDATE ON integration.playback_capture_session FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_v2_guard_session()","integration.playback_capture_v2_guard_session()","integration.playback_capture_session",false,"O",false,"playback_capture_v2_session_guard",23]],
    [0,["",[],null,"CREATE TRIGGER playback_decoder_observation_immutable BEFORE INSERT OR UPDATE ON integration.playback_decoder_observation FOR EACH ROW EXECUTE FUNCTION integration.playback_decoder_observation_guard()","integration.playback_decoder_observation_guard()","integration.playback_decoder_observation",false,"O",false,"playback_decoder_observation_immutable",23]],
    [0,["",[],null,"CREATE TRIGGER playback_decoder_observation_release AFTER DELETE ON integration.playback_decoder_observation FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_decoder_observation",false,"O",false,"playback_decoder_observation_release",9]],
    [0,["",[],null,"CREATE TRIGGER playback_decoder_observation_revision BEFORE DELETE ON integration.playback_decoder_observation FOR EACH ROW EXECUTE FUNCTION integration.playback_decoder_observation_invalidate()","integration.playback_decoder_observation_invalidate()","integration.playback_decoder_observation",false,"O",false,"playback_decoder_observation_revision",11]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_edition_capture_guard AFTER INSERT OR DELETE OR UPDATE ON integration.playback_edition_capture DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_edition_guard()","integration.playback_edition_guard()","integration.playback_edition_capture",true,"O",true,"playback_edition_capture_guard",29]],
    [0,["",[],null,"CREATE TRIGGER playback_edition_capture_release AFTER DELETE ON integration.playback_edition_capture FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_edition_capture",false,"O",false,"playback_edition_capture_release",9]],
    [0,["",["live_capture_session_id"],null,"CREATE TRIGGER playback_edition_capture_unlink AFTER UPDATE OF live_capture_session_id ON integration.playback_edition_capture FOR EACH ROW EXECUTE FUNCTION integration.playback_edition_unlink_revision()","integration.playback_edition_unlink_revision()","integration.playback_edition_capture",false,"O",false,"playback_edition_capture_unlink",17]],
    [0,["",[],null,"CREATE CONSTRAINT TRIGGER playback_edition_selection_guard AFTER INSERT OR DELETE OR UPDATE ON integration.playback_edition_selection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.playback_edition_guard()","integration.playback_edition_guard()","integration.playback_edition_selection",true,"O",true,"playback_edition_selection_guard",29]],
    [0,["",[],null,"CREATE TRIGGER playback_edition_selection_release AFTER DELETE ON integration.playback_edition_selection FOR EACH ROW EXECUTE FUNCTION integration.playback_capture_release_charge()","integration.playback_capture_release_charge()","integration.playback_edition_selection",false,"O",false,"playback_edition_selection_release",9]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7],"direct:C9":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39],"direct:CA":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39],"direct:CF":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39],"separate-owner:C0":[0,1,2,3,4,5,6,7],"separate-owner:C9":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39],"separate-owner:CA":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39],"separate-owner:CF":[0,1,2,8,9,10,11,3,12,13,4,14,15,16,17,18,19,20,21,22,23,24,25,26,27,5,6,28,29,30,7,31,32,33,34,35,36,37,38,39]}},
  "policies":{"fields":[],"rows":[

  ],"states":{"direct:C0":[],"direct:C9":[],"direct:CA":[],"direct:CF":[],"separate-owner:C0":[],"separate-owner:C9":[],"separate-owner:CA":[],"separate-owner:CF":[]}},
  "table_acl":{"fields":[["default_acl","grantee","grantor","is_grantable","privilege_type","relation"]],"rows":[
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","app.album_list_item_progress"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","app.album_list_item_progress"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","app.album_list_item_progress"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","app.album_list_item_progress"]],
    [0,[false,"album_haven_app","$migration_owner",false,"DELETE","app.album_list_items"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","app.album_list_items"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","app.album_list_items"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","app.album_list_items"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","app.album_list_items"]],
    [0,[false,"album_haven_app","$migration_owner",false,"DELETE","app.album_ratings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","app.album_ratings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","app.album_ratings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","app.album_ratings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","app.album_ratings"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","app.album_ratings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_anchor"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_anchor"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_anchor"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_anchor"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_anchor"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_budget"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_budget"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_budget"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_budget"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_budget"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_checkpoint"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_checkpoint"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_checkpoint"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_checkpoint"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_checkpoint"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_run"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_run"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_run"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_run"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_run"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_session"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_session"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_session"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_session"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_session"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","app.album_top_listening_settings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","app.album_top_listening_settings"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","app.album_top_listening_settings"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_album_metrics_state"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_album_metrics_state"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_album_metrics_state"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_album_metrics_state"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_album_metrics_state"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_history_revision"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_history_revision"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_history_revision"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_history_revision"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_history_revision"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_loss"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_loss"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_loss"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_loss"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_loss"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_capture_owner"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_capture_owner"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_capture_owner"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_capture_owner"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_capture_owner"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_decoder_observation"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_decoder_observation"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_decoder_observation"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_decoder_observation"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_decoder_observation"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_edition_capture"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_edition_capture"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_edition_capture"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_edition_capture"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_edition_capture"]],
    [0,[false,"album_haven_app","$migration_owner",false,"INSERT","integration.playback_edition_selection"]],
    [0,[false,"album_haven_app","$migration_owner",false,"SELECT","integration.playback_edition_selection"]],
    [0,[false,"album_haven_app","$migration_owner",false,"UPDATE","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"DELETE","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"INSERT","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"MAINTAIN","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"REFERENCES","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"SELECT","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRIGGER","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"TRUNCATE","integration.playback_edition_selection"]],
    [0,[false,"$migration_owner","$migration_owner",false,"UPDATE","integration.playback_edition_selection"]],
    [0,[false,"album_haven_readonly","$migration_owner",false,"SELECT","integration.playback_edition_selection"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"DELETE","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"INSERT","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"MAINTAIN","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"REFERENCES","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"SELECT","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRIGGER","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRUNCATE","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"UPDATE","app.album_list_item_progress"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"DELETE","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"INSERT","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"MAINTAIN","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"REFERENCES","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"SELECT","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRIGGER","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRUNCATE","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"UPDATE","app.album_list_items"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"INSERT","app.album_ratings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"SELECT","app.album_ratings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"UPDATE","app.album_ratings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"DELETE","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"INSERT","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"MAINTAIN","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"REFERENCES","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"SELECT","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRIGGER","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"TRUNCATE","app.album_top_listening_settings"]],
    [0,[false,"album_haven_migrator","$migration_owner",false,"UPDATE","app.album_top_listening_settings"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95],"direct:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189],"direct:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189],"direct:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189],"separate-owner:C0":[0,1,2,190,191,192,193,194,195,196,197,3,4,5,6,7,8,9,10,11,12,13,14,198,199,200,201,202,203,204,205,15,16,17,18,19,20,21,22,23,24,25,26,206,207,208,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95],"separate-owner:C9":[0,1,2,190,191,192,193,194,195,196,197,3,4,5,6,7,8,9,10,11,12,13,14,198,199,200,201,202,203,204,205,15,16,17,18,19,20,21,22,23,24,25,26,206,207,208,27,28,29,30,31,32,33,34,35,96,97,209,210,211,212,213,214,215,216,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189],"separate-owner:CA":[0,1,2,190,191,192,193,194,195,196,197,3,4,5,6,7,8,9,10,11,12,13,14,198,199,200,201,202,203,204,205,15,16,17,18,19,20,21,22,23,24,25,26,206,207,208,27,28,29,30,31,32,33,34,35,96,97,209,210,211,212,213,214,215,216,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189],"separate-owner:CF":[0,1,2,190,191,192,193,194,195,196,197,3,4,5,6,7,8,9,10,11,12,13,14,198,199,200,201,202,203,204,205,15,16,17,18,19,20,21,22,23,24,25,26,206,207,208,27,28,29,30,31,32,33,34,35,96,97,209,210,211,212,213,214,215,216,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189]}},
  "column_acl":{"fields":[["attname","grantee","grantor","is_grantable","privilege_type","relation"]],"rows":[
    [0,["completed_target","album_haven_app","$migration_owner",false,"UPDATE","app.album_top_listening_settings"]],
    [0,["revision","album_haven_app","$migration_owner",false,"UPDATE","app.album_top_listening_settings"]],
    [0,["updated_at","album_haven_app","$migration_owner",false,"UPDATE","app.album_top_listening_settings"]]
  ],"states":{"direct:C0":[],"direct:C9":[0,1,2],"direct:CA":[0,1,2],"direct:CF":[0,1,2],"separate-owner:C0":[],"separate-owner:C9":[0,1,2],"separate-owner:CA":[0,1,2],"separate-owner:CF":[0,1,2]}},
  "functions":{"fields":[["acl","arguments","declared_arguments","default_acl","identity","lanname","nspname","owner","proconfig","procost","proisstrict","prokind","proleakproof","proname","pronargdefaults","proparallel","prorows","prosecdef","prosrc","provolatile","result"]],"rows":[
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",false,"app._artwork_publication_closure_guard()","plpgsql","app","$migration_owner",["search_path=pg_catalog"],100.0,false,"f",false,"_artwork_publication_closure_guard",0,"u",0.0,true,"\ndeclare old_top uuid; new_top uuid; frozen boolean:=false;\nbegin\n  if TG_TABLE_NAME='album_list_operations' then\n    if TG_OP='UPDATE' and (OLD.actor_account_id,OLD.library_id,OLD.request_key,\n        OLD.original_session_id,OLD.action,OLD.top_ref,OLD.command_digest,OLD.publication_ref,OLD.receipt)\n        is not distinct from (NEW.actor_account_id,NEW.library_id,NEW.request_key,\n        NEW.original_session_id,NEW.action,NEW.top_ref,NEW.command_digest,NEW.publication_ref,NEW.receipt) then return NEW; end if;\n    if TG_OP<>'INSERT' then frozen:=app._artwork_publication_receipt_frozen(OLD.actor_account_id,OLD.library_id,OLD.request_key); end if;\n    if TG_OP<>'DELETE' then frozen:=frozen or app._artwork_publication_receipt_frozen(NEW.actor_account_id,NEW.library_id,NEW.request_key); end if;\n  else\n    if TG_TABLE_NAME='album_lists' then\n      if TG_OP='UPDATE' and (OLD.ref,OLD.library_id,OLD.owner_account_id,OLD.revision,OLD.title,\n          OLD.description,OLD.next_original_position,OLD.deleted_at) is not distinct from\n          (NEW.ref,NEW.library_id,NEW.owner_account_id,NEW.revision,NEW.title,\n          NEW.description,NEW.next_original_position,NEW.deleted_at) then return NEW; end if;\n      if TG_OP<>'INSERT' then old_top:=OLD.ref; end if;\n      if TG_OP<>'DELETE' then new_top:=NEW.ref; end if;\n    elsif TG_TABLE_NAME='shared_links' then\n      if TG_OP='UPDATE' and (OLD.ref,OLD.top_ref,OLD.library_id,OLD.state,OLD.active_publication_ref,OLD.link_revision)\n          is not distinct from (NEW.ref,NEW.top_ref,NEW.library_id,NEW.state,NEW.active_publication_ref,NEW.link_revision) then return NEW; end if;\n      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;\n      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;\n    elsif TG_TABLE_NAME='album_list_items' then\n      if TG_OP='UPDATE' and (OLD.ref,OLD.top_ref,OLD.library_id,OLD.catalog_ref,OLD.original_position,OLD.curator_position)\n          is not distinct from (NEW.ref,NEW.top_ref,NEW.library_id,NEW.catalog_ref,NEW.original_position,NEW.curator_position) then return NEW; end if;\n      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;\n      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;\n    elsif TG_TABLE_NAME='album_list_item_publication_sources' then\n      if TG_OP='UPDATE' and (OLD.top_ref,OLD.item_ref,OLD.library_id,OLD.catalog_ref,OLD.selected_local_album_id,OLD.selected_source_ref)\n          is not distinct from (NEW.top_ref,NEW.item_ref,NEW.library_id,NEW.catalog_ref,NEW.selected_local_album_id,NEW.selected_source_ref) then return NEW; end if;\n      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;\n      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;\n    elsif TG_TABLE_NAME='album_list_item_remote_sources' then\n      if TG_OP='UPDATE' and OLD is not distinct from NEW then return NEW; end if;\n      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;\n      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;\n    else\n      raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Unsupported artwork closure relation';\n    end if;\n    frozen:=app._artwork_publication_top_frozen(old_top) or app._artwork_publication_top_frozen(new_top);\n  end if;\n  if frozen then\n    raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Consumed artwork publication closure is frozen';\n  end if;\n  if TG_OP='DELETE' then return OLD; end if;\n  return NEW;\nend ","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",false,"app.guard_album_top_source_structure()","plpgsql","app","$migration_owner",null,100.0,false,"f",false,"guard_album_top_source_structure",0,"u",0.0,false,"\ndeclare target uuid; locked boolean;\nbegin\n  if tg_op='UPDATE' and (new.ref,new.top_ref,new.library_id,new.catalog_ref,new.original_position,new.curator_position)\n      is not distinct from (old.ref,old.top_ref,old.library_id,old.catalog_ref,old.original_position,old.curator_position) then\n    return new;\n  end if;\n  if tg_op='INSERT' then target=new.top_ref; else target=old.top_ref; end if;\n  select source_locked into locked from app.album_lists where ref=target for share;\n  if coalesce(locked,false) then\n    raise exception 'source structure is locked' using errcode='55000',constraint='album_top_source_locked';\n  end if;\n  if tg_op='UPDATE' and new.top_ref is distinct from old.top_ref then\n    select source_locked into locked from app.album_lists where ref=new.top_ref for share;\n    if coalesce(locked,false) then\n      raise exception 'source structure is locked' using errcode='55000',constraint='album_top_source_locked';\n    end if;\n  end if;\n  if tg_op='DELETE' then return old; end if;\n  return new;\nend ","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",false,"app.invalidate_home_album_taste()","plpgsql","app","$migration_owner",["search_path=pg_catalog"],100.0,false,"f",false,"invalidate_home_album_taste",0,"u",0.0,true,"\ndeclare\n  old_library bigint; old_account bigint;\n  new_library bigint; new_account bigint;\n  affected record;\nbegin\n  if TG_OP = 'UPDATE' and\n      row(OLD.account_id, OLD.library_id, OLD.album_key, OLD.rating,\n          OLD.favorite, OLD.preference_revision) is not distinct from\n      row(NEW.account_id, NEW.library_id, NEW.album_key, NEW.rating,\n          NEW.favorite, NEW.preference_revision) then\n    return NEW;\n  end if;\n  if TG_OP != 'INSERT' then\n    old_library := OLD.library_id; old_account := OLD.account_id;\n  end if;\n  if TG_OP != 'DELETE' then\n    new_library := NEW.library_id; new_account := NEW.account_id;\n  end if;\n  for affected in\n    select distinct scope.library_id, scope.account_id\n    from (values (old_library, old_account), (new_library, new_account))\n      as scope(library_id, account_id)\n    where scope.library_id > 0 and scope.account_id > 0\n    order by scope.library_id, scope.account_id\n  loop\n    perform app.bump_home_album_taste_revision(affected.library_id, affected.account_id);\n  end loop;\n  if TG_OP = 'DELETE' then return OLD; end if;\n  return NEW;\nend ","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_anonymize()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_anonymize",0,"u",0.0,false,"\nbegin\n  if new.account_id is null then\n    new.auth_session_guard := null;\n    new.device_uuid := null;\n    new.capture_uuid := null;\n    new.v1_session_uuid := null;\n    new.account_budget_id := null;\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_release_charge()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_release_charge",0,"u",0.0,false,"\nbegin\n  if old.account_budget_id is not null then\n    update integration.playback_capture_budget\n       set reserved_bytes=reserved_bytes-old.reservation_bytes\n     where id=old.account_budget_id and not is_global;\n  end if;\n  update integration.playback_capture_budget\n     set reserved_bytes=reserved_bytes-old.reservation_bytes where is_global;\n  return old;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",false,"app.guard_album_top_listening_settings()","plpgsql","app","$migration_owner",["search_path=pg_catalog"],100.0,false,"f",false,"guard_album_top_listening_settings",0,"u",0.0,false,"\nbegin\n  if NEW.account_id is distinct from OLD.account_id\n      or NEW.created_at is distinct from OLD.created_at\n      or NEW.revision::numeric <> OLD.revision::numeric + 1\n      or NEW.updated_at < OLD.updated_at then\n    raise exception using errcode='23514',constraint='album_top_listening_settings_revision',\n      message='Listening settings identity or revision transition is invalid';\n  end if;\n  return NEW;\nend ","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_album_metrics_state_guard()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_album_metrics_state_guard",0,"u",0.0,false," begin\n if TG_OP='UPDATE' and not exists(select 1 from app.accounts where id=old.account_id) then\n   if (to_jsonb(new)-'account_budget_id') is distinct from (to_jsonb(old)-'account_budget_id')\n      or new.account_budget_id is not null then raise exception 'invalid account cleanup'; end if;\n   return new;\n end if;\n if not exists(select 1 from integration.playback_capture_budget\n     where id=new.account_budget_id and account_id=new.account_id and not is_global) then\n   raise exception 'invalid derived metrics account budget';\n end if;\n if TG_OP='UPDATE' and (new.account_id<>old.account_id or\n   new.original_library_id<>old.original_library_id or new.original_album_id<>old.original_album_id or\n   new.state_revision<>old.state_revision+1 or new.reservation_bytes<old.reservation_bytes or\n   new.account_budget_id is distinct from old.account_budget_id) then\n   raise exception 'invalid derived metrics update';\n end if;\n if new.reservation_bytes<1024+octet_length(new.state::text) then\n   raise exception 'unreserved derived metrics state';\n end if;\n return new;\nend ","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_anonymize()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_anonymize",0,"u",0.0,false,"\nbegin\n  if new.account_id is null then\n    if new.evidence_version='app-rendered-position-v2' then\n      if old.account_id is not null\n         and exists(select 1 from app.accounts where id=old.account_id) then\n        raise exception 'direct capture anonymization is unsupported' using errcode='23514';\n      end if;\n      new.owner_id := null;\n      new.owner_uuid := null;\n      update integration.playback_capture_checkpoint\n         set evidence=evidence-'owner_uuid', digest=null,\n             receipt_body=receipt_body-'digest', evidence_redacted=true\n       where session_id=old.id and not evidence_redacted;\n    end if;\n    -- Exact v1 identity-clearing behavior is preserved.\n    new.auth_session_guard := null;\n    new.device_uuid := null;\n    new.capture_uuid := null;\n    new.v1_session_uuid := null;\n    new.account_budget_id := null;\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_history_check_revision()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_history_check_revision",0,"u",0.0,false,"\ndeclare h integration.playback_capture_history_revision%rowtype;\nbegin\n  select * into h from integration.playback_capture_history_revision where account_id=new.account_id;\n  if not found then return null; end if;\n  if not exists(select 1 from integration.playback_capture_budget b\n      where b.id=h.account_budget_id and b.account_id=h.account_id and not b.is_global) then\n    raise exception 'invalid capture history budget binding' using errcode='23514';\n  end if;\n  return null;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_history_guard_revision()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_history_guard_revision",0,"u",0.0,false,"\nbegin\n  if tg_op='DELETE' then\n    if exists(select 1 from app.accounts where id=old.account_id) then\n      raise exception 'live capture history revision deletion is unsupported' using errcode='23514';\n    end if;\n    return old;\n  end if;\n  if row(new.account_id,new.reservation_bytes) is distinct from row(old.account_id,old.reservation_bytes)\n     or (new.account_budget_id is distinct from old.account_budget_id and new.account_budget_id is not null)\n     or new.append_revision<old.append_revision\n     or new.invalidation_revision<old.invalidation_revision or new.proof_revision<old.proof_revision\n     or (old.raw_checkpoint_cut is not null\n         and (new.raw_checkpoint_cut is null or new.raw_checkpoint_cut<old.raw_checkpoint_cut)) then\n    raise exception 'invalid capture history revision mutation' using errcode='23514';\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"aid bigint","aid bigint",true,"integration.playback_capture_history_invalidate(bigint)","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_history_invalidate",0,"u",0.0,false,"\nbegin\n  -- Account DELETE owns removal of the revision row. Do not block privacy\n  -- redaction or account destruction on an exhausted soon-to-disappear counter.\n  if aid is null or not exists(select 1 from app.accounts where id=aid) then return; end if;\n  -- No row means unsupported/uninitialized history, never a usable zero cut.\n  update integration.playback_capture_history_revision\n     set invalidation_revision=invalidation_revision+1 where account_id=aid;\n  -- Signed bigint overflow raises and rolls back the destructive transaction.\nend;\n","v","void"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_history_raw_mutation()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_history_raw_mutation",0,"u",0.0,false,"\ndeclare aid bigint;\nbegin\n  if tg_table_name='playback_capture_owner' then\n    aid := old.account_id;\n    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.device_uuid,\n        new.auth_session_guard,new.owner_uuid) is not distinct from\n        row(old.id,old.account_id,old.library_id,old.device_uuid,old.auth_session_guard,old.owner_uuid)\n      then return new; end if;\n  elsif tg_table_name='playback_capture_session' then\n    if old.evidence_version<>'app-rendered-position-v2' then\n      if tg_op='DELETE' then return old; else return new; end if;\n    end if;\n    aid := old.account_id;\n    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.auth_session_guard,\n        new.device_uuid,new.capture_uuid,new.v1_session_uuid,new.evidence_version,\n        new.owner_id,new.owner_uuid,new.original_track_id,new.original_album_id,\n        new.original_file_id,new.original_root_id,new.disc_number,new.track_number,new.admitted_at)\n      is not distinct from row(old.id,old.account_id,old.library_id,old.auth_session_guard,\n        old.device_uuid,old.capture_uuid,old.v1_session_uuid,old.evidence_version,\n        old.owner_id,old.owner_uuid,old.original_track_id,old.original_album_id,\n        old.original_file_id,old.original_root_id,old.disc_number,old.track_number,old.admitted_at)\n      then return new; end if;\n    -- Ordinary progress and independently nullable live pointers are not frozen\n    -- cut evidence. The H2 final current-track AND invalid-parent probes remain\n    -- mandatory even with unchanged revisions; this trigger is no substitute.\n  elsif tg_table_name='playback_capture_checkpoint' then\n    select p.account_id into aid from integration.playback_capture_session p\n      where p.id=old.session_id and p.evidence_version='app-rendered-position-v2';\n    if tg_op='UPDATE' and row(new.id,new.session_id,new.sequence,new.digest,new.evidence,\n        new.evidence_redacted,new.accepted_at,new.known_frames,new.lost_frames,\n        new.terminal,new.terminal_reason,new.receipt_status,new.receipt_body)\n      is not distinct from row(old.id,old.session_id,old.sequence,old.digest,old.evidence,\n        old.evidence_redacted,old.accepted_at,old.known_frames,old.lost_frames,\n        old.terminal,old.terminal_reason,old.receipt_status,old.receipt_body)\n      then return new; end if;\n  elsif tg_table_name in ('playback_capture_run','playback_capture_loss') then\n    select p.account_id into aid from integration.playback_capture_checkpoint cp\n      join integration.playback_capture_session p on p.id=cp.session_id\n      where cp.id=old.checkpoint_id and p.evidence_version='app-rendered-position-v2';\n    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')\n        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;\n  elsif tg_table_name='playback_capture_anchor' then\n    select p.account_id into aid from integration.playback_capture_session p\n      where p.id=old.session_id and p.evidence_version='app-rendered-position-v2';\n    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')\n        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;\n  else\n    raise exception 'unsupported capture history mutation owner' using errcode='23514';\n  end if;\n  perform integration.playback_capture_history_invalidate(aid);\n  if tg_op='DELETE' then return old; else return new; end if;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"aid bigint","aid bigint",true,"integration.playback_capture_v2_assert_anchor(bigint)","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_assert_anchor",0,"u",0.0,false,"\ndeclare a integration.playback_capture_anchor%rowtype;\n        p integration.playback_capture_session%rowtype;\nbegin\n  select * into a from integration.playback_capture_anchor where id=aid;\n  if not found then return; end if;\n  select * into p from integration.playback_capture_session where id=a.session_id;\n  if p.evidence_version='app-rendered-position-v2' then\n    perform integration.playback_capture_v2_assert_session(p.id);\n    if a.account_budget_id is distinct from p.account_budget_id then\n      raise exception 'invalid capture anchor binding' using errcode='23514';\n    end if;\n  end if;\nend;\n","v","void"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"cid bigint, check_runs boolean","cid bigint, check_runs boolean",true,"integration.playback_capture_v2_assert_checkpoint(bigint,boolean)","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_assert_checkpoint",0,"u",0.0,false,"\ndeclare c integration.playback_capture_checkpoint%rowtype;\n        p integration.playback_capture_session%rowtype;\n        g integration.playback_capture_loss%rowtype;\n        n integer;\n        seen integer := 0;\n        body jsonb;\n        child record;\nbegin\n  select * into c from integration.playback_capture_checkpoint where id=cid;\n  -- Skip only the authoritative checkpoint, never a vanished loss-row key.\n  if not found then return; end if;\n  select * into p from integration.playback_capture_session where id=c.session_id;\n  perform integration.playback_capture_v2_assert_session(p.id);\n  if p.evidence_version='app-rendered-position-v1' then\n    if c.evidence_redacted or c.digest is null\n       or exists(select 1 from integration.playback_capture_loss where checkpoint_id=c.id) then\n      raise exception 'invalid legacy checkpoint projection' using errcode='23514';\n    end if;\n  else\n    if c.account_budget_id is distinct from p.account_budget_id\n       or jsonb_typeof(c.evidence->'gaps') is distinct from 'array'\n       or jsonb_typeof(c.evidence->'runs') is distinct from 'array' then\n      raise exception 'invalid capture checkpoint binding' using errcode='23514';\n    end if;\n    if p.account_id is null then\n      if not c.evidence_redacted or c.digest is not null or c.evidence ? 'owner_uuid'\n         or c.receipt_body ? 'digest' then\n        raise exception 'invalid capture redaction' using errcode='23514';\n      end if;\n    elsif c.evidence_redacted or c.evidence->>'owner_uuid' is distinct from p.owner_uuid::text\n          or c.digest is null or c.receipt_body->>'digest' is distinct from c.digest then\n      raise exception 'invalid capture checkpoint identity' using errcode='23514';\n    end if;\n    n := jsonb_array_length(c.evidence->'gaps');\n    if n>8 or jsonb_array_length(c.evidence->'runs')>256 then\n      raise exception 'invalid capture projection size' using errcode='23514';\n    end if;\n    for g in select * from integration.playback_capture_loss\n              where checkpoint_id=c.id order by gap_index loop\n      body := c.evidence->'gaps'->g.gap_index;\n      if g.gap_index<>seen or g.gap_index>=n\n         or g.owner_id is distinct from p.owner_id\n         or g.account_budget_id is distinct from p.account_budget_id\n         or jsonb_build_array(g.ordinal_start,g.ordinal_end,g.output_start,g.output_end)\n            is distinct from jsonb_build_array(body->'ordinal_start',body->'ordinal_end',\n                                               body->'output_start',body->'output_end') then\n        raise exception 'invalid capture loss projection' using errcode='23514';\n      end if;\n      seen := seen+1;\n    end loop;\n    if seen<>n then\n      raise exception 'incomplete capture loss projection' using errcode='23514';\n    end if;\n  end if;\n  if check_runs then\n    for child in select id from integration.playback_capture_run where checkpoint_id=c.id loop\n      perform integration.playback_capture_v2_assert_run(child.id);\n    end loop;\n  end if;\nend;\n","v","void"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"rid bigint","rid bigint",true,"integration.playback_capture_v2_assert_run(bigint)","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_assert_run",0,"u",0.0,false,"\ndeclare r integration.playback_capture_run%rowtype;\n        c integration.playback_capture_checkpoint%rowtype;\n        p integration.playback_capture_session%rowtype;\n        body jsonb;\nbegin\n  select * into r from integration.playback_capture_run where id=rid;\n  if not found then return; end if;\n  select * into c from integration.playback_capture_checkpoint where id=r.checkpoint_id;\n  select * into p from integration.playback_capture_session where id=c.session_id;\n  perform integration.playback_capture_v2_assert_session(p.id);\n  if p.evidence_version='app-rendered-position-v1' then\n    if r.owner_id is not null or r.binding_serial is not null or r.generation is not null\n       or r.stream_id is not null or r.source_base48 is not null\n       or r.continuity_serial is not null or r.reservation_bytes<>128 then\n      raise exception 'invalid legacy capture run' using errcode='23514';\n    end if;\n    return;\n  end if;\n  body := c.evidence->'runs'->r.run_index;\n  if r.owner_id is distinct from p.owner_id\n     or r.account_budget_id is distinct from p.account_budget_id\n     or r.reservation_bytes<>320\n     or r.binding_serial is null or r.generation is null or r.stream_id is null\n     or r.source_base48 is null or r.continuity_serial is null\n     or r.source_start48<r.source_base48\n     or jsonb_build_array(r.source_start48,r.frames,r.output_start,r.ordinal_start,r.epoch,\n                         r.binding_serial,r.generation,r.stream_id,r.source_base48,r.continuity_serial)\n        is distinct from jsonb_build_array(body->'source_start48',body->'frames',body->'output_start',\n                         body->'ordinal_start',body->'epoch',body->'binding_serial',body->'generation',\n                         body->'stream_id',body->'source_base48',body->'continuity_serial') then\n    raise exception 'invalid capture run binding' using errcode='23514';\n  end if;\nend;\n","v","void"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"sid bigint","sid bigint",true,"integration.playback_capture_v2_assert_session(bigint)","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_assert_session",0,"u",0.0,false,"\ndeclare p integration.playback_capture_session%rowtype;\n        o integration.playback_capture_owner%rowtype;\nbegin\n  select * into p from integration.playback_capture_session where id=sid;\n  if not found then return; end if;\n  if p.evidence_version='app-rendered-position-v1' then\n    if p.owner_id is not null or p.owner_uuid is not null or p.reservation_bytes<>256 then\n      raise exception 'invalid legacy capture binding' using errcode='23514';\n    end if;\n    return;\n  end if;\n  if p.reservation_bytes<>384 then\n    raise exception 'invalid capture charge' using errcode='23514';\n  end if;\n  if p.account_id is null then\n    if p.owner_id is not null or p.owner_uuid is not null or p.account_budget_id is not null then\n      raise exception 'invalid redacted capture binding' using errcode='23514';\n    end if;\n    return;\n  end if;\n  select * into o from integration.playback_capture_owner where id=p.owner_id;\n  if not found or row(o.account_id,o.library_id,o.device_uuid,o.auth_session_guard,\n                       o.owner_uuid,o.account_budget_id)\n       is distinct from row(p.account_id,p.library_id,p.device_uuid,p.auth_session_guard,\n                            p.owner_uuid,p.account_budget_id)\n     or not exists(select 1 from integration.playback_capture_budget\n                    where id=p.account_budget_id and account_id=p.account_id and not is_global) then\n    raise exception 'invalid capture owner binding' using errcode='23514';\n  end if;\nend;\n","v","void"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_v2_check_graph()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_check_graph",0,"u",0.0,false,"\ndeclare child record;\n        o integration.playback_capture_owner%rowtype;\nbegin\n  if tg_table_name='playback_capture_loss' then\n    if tg_op in ('UPDATE','DELETE') then\n      perform integration.playback_capture_v2_assert_checkpoint(old.checkpoint_id,false);\n    end if;\n    if tg_op='INSERT' or (tg_op='UPDATE' and new.checkpoint_id is distinct from old.checkpoint_id) then\n      perform integration.playback_capture_v2_assert_checkpoint(new.checkpoint_id,false);\n    end if;\n  elsif tg_table_name='playback_capture_checkpoint' then\n    perform integration.playback_capture_v2_assert_checkpoint(new.id,true);\n    if tg_op='UPDATE' and new.session_id is distinct from old.session_id then\n      perform integration.playback_capture_v2_assert_session(old.session_id);\n    end if;\n  elsif tg_table_name='playback_capture_run' then\n    perform integration.playback_capture_v2_assert_run(new.id);\n  elsif tg_table_name='playback_capture_anchor' then\n    perform integration.playback_capture_v2_assert_anchor(new.id);\n  elsif tg_table_name='playback_capture_session' then\n    perform integration.playback_capture_v2_assert_session(new.id);\n    -- Ordinary progress updates do not rescan an entire retained parent.\n    if tg_op='INSERT' or row(new.account_id,new.library_id,new.owner_id,new.owner_uuid,\n       new.device_uuid,new.auth_session_guard,new.account_budget_id,new.evidence_version)\n       is distinct from row(old.account_id,old.library_id,old.owner_id,old.owner_uuid,\n       old.device_uuid,old.auth_session_guard,old.account_budget_id,old.evidence_version) then\n      for child in select id from integration.playback_capture_checkpoint where session_id=new.id loop\n        perform integration.playback_capture_v2_assert_checkpoint(child.id,true);\n      end loop;\n      for child in select id from integration.playback_capture_anchor where session_id=new.id loop\n        perform integration.playback_capture_v2_assert_anchor(child.id);\n      end loop;\n    end if;\n  elsif tg_table_name='playback_capture_owner' then\n    select * into o from integration.playback_capture_owner\n      where id=case when tg_op='DELETE' then old.id else new.id end;\n    if found then\n      if not exists(select 1 from integration.playback_capture_budget\n                     where id=o.account_budget_id and account_id=o.account_id and not is_global) then\n        raise exception 'invalid retained capture owner' using errcode='23514';\n      end if;\n      for child in select id from integration.playback_capture_session where owner_id=o.id loop\n        perform integration.playback_capture_v2_assert_session(child.id);\n      end loop;\n    end if;\n  end if;\n  return null;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_v2_cleanup_owner()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_cleanup_owner",0,"u",0.0,false,"\ndeclare o integration.playback_capture_owner%rowtype;\nbegin\n  if old.owner_id is null then return null; end if;\n  select * into o from integration.playback_capture_owner where id=old.owner_id;\n  if not found then return null; end if;\n  -- Nonlocking owner lookup, then the established account -> global budget\n  -- order, before owner DELETE. No new live-account anonymization path.\n  perform id from integration.playback_capture_budget\n    where id=o.account_budget_id and not is_global for update;\n  perform id from integration.playback_capture_budget where is_global for update;\n  if not exists(select 1 from integration.playback_capture_session where owner_id=o.id) then\n    delete from integration.playback_capture_owner where id=o.id;\n  end if;\n  return null;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_v2_guard_checkpoint()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_guard_checkpoint",0,"u",0.0,false,"\ndeclare p integration.playback_capture_session%rowtype;\nbegin\n  select * into p from integration.playback_capture_session where id=old.session_id;\n  if p.evidence_version<>'app-rendered-position-v2' then return new; end if;\n  if row(new.id,new.session_id,new.sequence,new.accepted_at,new.known_frames,\n         new.lost_frames,new.terminal,new.terminal_reason,new.receipt_status,new.reservation_bytes)\n     is distinct from row(old.id,old.session_id,old.sequence,old.accepted_at,old.known_frames,\n         old.lost_frames,old.terminal,old.terminal_reason,old.receipt_status,old.reservation_bytes)\n     or (new.account_budget_id is distinct from old.account_budget_id\n         and new.account_budget_id is not null) then\n    raise exception 'capture checkpoint is immutable' using errcode='23514';\n  end if;\n  if row(new.evidence,new.digest,new.receipt_body,new.evidence_redacted)\n     is not distinct from row(old.evidence,old.digest,old.receipt_body,old.evidence_redacted) then\n    return new;\n  end if;\n  if not old.evidence_redacted and new.evidence_redacted and new.digest is null\n     and new.evidence=old.evidence-'owner_uuid'\n     and new.receipt_body=old.receipt_body-'digest'\n     and (p.account_id is null or not exists(select 1 from app.accounts where id=p.account_id)) then\n    return new;\n  end if;\n  raise exception 'capture checkpoint is immutable' using errcode='23514';\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_v2_guard_owner()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_guard_owner",0,"u",0.0,false,"\nbegin\n  if row(new.id,new.account_id,new.library_id,new.device_uuid,new.auth_session_guard,\n         new.owner_uuid,new.reservation_bytes)\n     is distinct from row(old.id,old.account_id,old.library_id,old.device_uuid,\n                          old.auth_session_guard,old.owner_uuid,old.reservation_bytes)\n     or (new.account_budget_id is distinct from old.account_budget_id\n         and new.account_budget_id is not null) then\n    raise exception 'capture owner is immutable' using errcode='23514';\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_capture_v2_guard_session()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_capture_v2_guard_session",0,"u",0.0,false,"\nbegin\n  if tg_op='UPDATE' and new.evidence_version is distinct from old.evidence_version then\n    raise exception 'capture version is immutable' using errcode='23514';\n  end if;\n  if new.evidence_version<>'app-rendered-position-v2' then return new; end if;\n  if tg_op='INSERT' then\n    if new.account_id is null or new.owner_id is null or new.owner_uuid is null then\n      raise exception 'capture requires initial owned state' using errcode='23514';\n    end if;\n    return new;\n  end if;\n  if new.account_id is distinct from old.account_id then\n    if new.account_id is not null or old.account_id is null\n       or exists(select 1 from app.accounts where id=old.account_id) then\n      raise exception 'direct capture anonymization is unsupported' using errcode='23514';\n    end if;\n    -- Genuine account DELETE only. Redaction is performed by the existing\n    -- anonymize trigger below; allow its cleared identity in either name order.\n    return new;\n  end if;\n  if row(new.id,new.library_id,new.auth_session_guard,new.device_uuid,new.capture_uuid,\n         new.v1_session_uuid,new.owner_uuid,new.original_track_id,new.original_file_id,\n         new.original_root_id,new.original_album_id,new.disc_number,new.track_number,\n         new.admitted_at,new.reservation_bytes)\n     is distinct from row(old.id,old.library_id,old.auth_session_guard,old.device_uuid,\n         old.capture_uuid,old.v1_session_uuid,old.owner_uuid,old.original_track_id,\n         old.original_file_id,old.original_root_id,old.original_album_id,\n         old.disc_number,old.track_number,old.admitted_at,old.reservation_bytes)\n     or (new.owner_id is distinct from old.owner_id and new.owner_id is not null)\n     or (new.account_budget_id is distinct from old.account_budget_id\n         and new.account_budget_id is not null) then\n    raise exception 'capture binding is immutable' using errcode='23514';\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_decoder_observation_guard()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_decoder_observation_guard",0,"u",0.0,false,"\nbegin\n  if tg_op='INSERT' then\n    if new.extent_frames48 is not null then\n      raise exception 'EOF requires admitted open' using errcode='23514';\n    end if;\n    if not exists(select 1 from integration.playback_capture_budget\n        where id=new.account_budget_id and account_id=new.account_id and not is_global) then\n      raise exception 'invalid observation account budget' using errcode='23514';\n    end if;\n    return new;\n  end if;\n  if exists(select 1 from app.accounts where id=old.account_id) then\n    if old.extent_frames48 is null and new.extent_frames48 is not null\n       and (to_jsonb(new)-'extent_frames48')=(to_jsonb(old)-'extent_frames48') then\n      return new;\n    end if;\n    raise exception 'decoder lineage immutable; EOF completion is one-way' using errcode='23514';\n  end if;\n  -- Only account-deletion FK cleanup may null the disappearing budget link.\n  if (to_jsonb(new)-'account_budget_id') is distinct from (to_jsonb(old)-'account_budget_id')\n     or new.account_budget_id is not null then\n    raise exception 'invalid decoder observation cleanup' using errcode='23514';\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_decoder_observation_invalidate()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_decoder_observation_invalidate",0,"u",0.0,false,"\nbegin\n  if exists(select 1 from app.accounts where id=old.account_id) then\n    update integration.playback_capture_history_revision set proof_revision=proof_revision+1\n      where account_id=old.account_id and proof_revision<9223372036854775807;\n    if not found then raise exception 'capture revision unavailable' using errcode='23514'; end if;\n  end if;\n  return old;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_edition_guard()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_edition_guard",0,"u",0.0,false,"\ndeclare current_budget bigint; aid bigint; actual jsonb;\nbegin\n  if tg_op='DELETE' then aid:=old.account_id; else aid:=new.account_id; end if;\n  if not exists(select 1 from app.accounts where id=aid) then\n    if tg_op='DELETE' then return old; else return new; end if;\n  end if;\n  if tg_op='DELETE' then\n    raise exception 'live edition selection deletion requires explicit retention policy' using errcode='23514';\n  end if;\n  if tg_table_name='playback_edition_selection' then\n    select to_jsonb(s) into actual from integration.playback_edition_selection s\n      where account_id=new.account_id and selection_ref=new.selection_ref;\n    if actual is null then return new; end if;\n    if tg_op='UPDATE' and new is distinct from old then\n      raise exception 'edition selection is immutable' using errcode='23514';\n    end if;\n  elsif tg_table_name='playback_edition_capture' then\n    select to_jsonb(s) into actual from integration.playback_edition_capture s\n      where account_id=new.account_id and original_capture_session_id=new.original_capture_session_id;\n    if actual is null then return new; end if;\n    if tg_op='UPDATE' and ((to_jsonb(new)-'live_capture_session_id') is distinct from\n        (to_jsonb(old)-'live_capture_session_id') or new.live_capture_session_id is not null) then\n      raise exception 'capture selection identity is immutable' using errcode='23514';\n    end if;\n    if actual->>'live_capture_session_id' is not null and not exists(\n      select 1 from integration.playback_capture_session p where p.id=(actual->>'live_capture_session_id')::bigint\n        and p.account_id=new.account_id and p.original_track_id=new.original_track_id\n        and p.evidence_version='app-rendered-position-v2') then\n      raise exception 'capture selection owner mismatch' using errcode='23514';\n    end if;\n    if actual->>'live_capture_session_id' is null and exists(select 1 from integration.playback_capture_session\n        where id=new.original_capture_session_id) then\n      raise exception 'live capture cannot be detached' using errcode='23514';\n    end if;\n  else\n    raise exception 'unsupported edition selection owner' using errcode='23514';\n  end if;\n  select id into current_budget from integration.playback_capture_budget\n    where account_id=new.account_id and not is_global;\n  if current_budget is null or (actual->>'account_budget_id')::bigint is distinct from current_budget then\n    raise exception 'edition selection budget mismatch' using errcode='23514';\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"PUBLIC","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",true,"integration.playback_edition_unlink_revision()","plpgsql","integration","$migration_owner",null,100.0,false,"f",false,"playback_edition_unlink_revision",0,"u",0.0,false,"\nbegin\n  if old.live_capture_session_id is not null and new.live_capture_session_id is null\n      and exists(select 1 from app.accounts where id=new.account_id) then\n    update integration.playback_capture_history_revision set proof_revision=proof_revision+1\n      where account_id=new.account_id and proof_revision<9223372036854775807;\n    if not found then\n      raise exception 'capture proof revision unavailable' using errcode='23514';\n    end if;\n  end if;\n  return new;\nend;\n","v","trigger"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"},{"grantee":"album_haven_migrator","grantor":"$migration_owner","grantable":false,"privilege":"EXECUTE"}],"","",false,"app.guard_album_top_listening_settings()","plpgsql","app","$migration_owner",["search_path=pg_catalog"],100.0,false,"f",false,"guard_album_top_listening_settings",0,"u",0.0,false,"\nbegin\n  if NEW.account_id is distinct from OLD.account_id\n      or NEW.created_at is distinct from OLD.created_at\n      or NEW.revision::numeric <> OLD.revision::numeric + 1\n      or NEW.updated_at < OLD.updated_at then\n    raise exception using errcode='23514',constraint='album_top_listening_settings_revision',\n      message='Listening settings identity or revision transition is invalid';\n  end if;\n  return NEW;\nend ","v","trigger"]]
  ],"states":{"direct:C0":[0,1,2,3,4],"direct:C9":[0,5,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24],"direct:CA":[0,5,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24],"direct:CF":[0,5,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24],"separate-owner:C0":[0,1,2,3,4],"separate-owner:C9":[0,25,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24],"separate-owner:CA":[0,25,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24],"separate-owner:CF":[0,25,1,2,6,7,8,9,10,11,4,12,13,14,15,16,17,18,19,20,21,22,23,24]}},
  "sequences":{"fields":[["acl","default_acl","owned_columns","owner","relation","seqcache","seqcycle","seqincrement","seqmax","seqmin","seqstart","type"]],"rows":[
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_anchor"}],"$migration_owner","integration.playback_capture_anchor_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_budget"}],"$migration_owner","integration.playback_capture_budget_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_checkpoint"}],"$migration_owner","integration.playback_capture_checkpoint_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_run"}],"$migration_owner","integration.playback_capture_run_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_session"}],"$migration_owner","integration.playback_capture_session_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_loss"}],"$migration_owner","integration.playback_capture_loss_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]],
    [0,[[{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"UPDATE"},{"grantee":"$migration_owner","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"},{"grantee":"album_haven_app","grantor":"$migration_owner","grantable":false,"privilege":"USAGE"},{"grantee":"album_haven_readonly","grantor":"$migration_owner","grantable":false,"privilege":"SELECT"}],false,[{"kind":"i","column":"id","relation":"integration.playback_capture_owner"}],"$migration_owner","integration.playback_capture_owner_id_seq",1,false,1,9223372036854775807,1,1,"bigint"]]
  ],"states":{"direct:C0":[0,1,2,3,4],"direct:C9":[0,1,2,5,6,3,4],"direct:CA":[0,1,2,5,6,3,4],"direct:CF":[0,1,2,5,6,3,4],"separate-owner:C0":[0,1,2,3,4],"separate-owner:C9":[0,1,2,5,6,3,4],"separate-owner:CA":[0,1,2,5,6,3,4],"separate-owner:CF":[0,1,2,5,6,3,4]}},
  "creator_defaults":{"fields":[["grantee","grantor","is_grantable","kind","owner","privilege_type","schema"]],"rows":[
    [0,["album_haven_app","$migration_owner",false,"S","$migration_owner","SELECT","app"]],
    [0,["album_haven_app","$migration_owner",false,"S","$migration_owner","USAGE","app"]],
    [0,["album_haven_readonly","$migration_owner",false,"S","$migration_owner","SELECT","app"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","INSERT","app"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","SELECT","app"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","UPDATE","app"]],
    [0,["album_haven_readonly","$migration_owner",false,"r","$migration_owner","SELECT","app"]],
    [0,["album_haven_app","$migration_owner",false,"S","$migration_owner","SELECT","integration"]],
    [0,["album_haven_app","$migration_owner",false,"S","$migration_owner","USAGE","integration"]],
    [0,["album_haven_readonly","$migration_owner",false,"S","$migration_owner","SELECT","integration"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","INSERT","integration"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","SELECT","integration"]],
    [0,["album_haven_app","$migration_owner",false,"r","$migration_owner","UPDATE","integration"]],
    [0,["album_haven_readonly","$migration_owner",false,"r","$migration_owner","SELECT","integration"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"direct:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"direct:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"direct:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"separate-owner:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"separate-owner:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13],"separate-owner:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13]}},
  "effective_table":{"fields":[["allowed","privilege","relation","role"]],"rows":[
    [0,[true,"INSERT","app.album_list_item_progress","album_haven_app"]],
    [0,[false,"REFERENCES","app.album_list_item_progress","album_haven_app"]],
    [0,[true,"SELECT","app.album_list_item_progress","album_haven_app"]],
    [0,[true,"UPDATE","app.album_list_item_progress","album_haven_app"]],
    [0,[true,"INSERT","app.album_list_item_progress","album_haven_migrator"]],
    [0,[true,"REFERENCES","app.album_list_item_progress","album_haven_migrator"]],
    [0,[true,"SELECT","app.album_list_item_progress","album_haven_migrator"]],
    [0,[true,"UPDATE","app.album_list_item_progress","album_haven_migrator"]],
    [0,[false,"INSERT","app.album_list_item_progress","album_haven_readonly"]],
    [0,[false,"REFERENCES","app.album_list_item_progress","album_haven_readonly"]],
    [0,[false,"SELECT","app.album_list_item_progress","album_haven_readonly"]],
    [0,[false,"UPDATE","app.album_list_item_progress","album_haven_readonly"]],
    [0,[true,"INSERT","app.album_list_items","album_haven_app"]],
    [0,[false,"REFERENCES","app.album_list_items","album_haven_app"]],
    [0,[true,"SELECT","app.album_list_items","album_haven_app"]],
    [0,[true,"UPDATE","app.album_list_items","album_haven_app"]],
    [0,[true,"INSERT","app.album_list_items","album_haven_migrator"]],
    [0,[true,"REFERENCES","app.album_list_items","album_haven_migrator"]],
    [0,[true,"SELECT","app.album_list_items","album_haven_migrator"]],
    [0,[true,"UPDATE","app.album_list_items","album_haven_migrator"]],
    [0,[false,"INSERT","app.album_list_items","album_haven_readonly"]],
    [0,[false,"REFERENCES","app.album_list_items","album_haven_readonly"]],
    [0,[false,"SELECT","app.album_list_items","album_haven_readonly"]],
    [0,[false,"UPDATE","app.album_list_items","album_haven_readonly"]],
    [0,[true,"INSERT","app.album_ratings","album_haven_app"]],
    [0,[false,"REFERENCES","app.album_ratings","album_haven_app"]],
    [0,[true,"SELECT","app.album_ratings","album_haven_app"]],
    [0,[true,"UPDATE","app.album_ratings","album_haven_app"]],
    [0,[true,"INSERT","app.album_ratings","album_haven_migrator"]],
    [0,[true,"REFERENCES","app.album_ratings","album_haven_migrator"]],
    [0,[true,"SELECT","app.album_ratings","album_haven_migrator"]],
    [0,[true,"UPDATE","app.album_ratings","album_haven_migrator"]],
    [0,[false,"INSERT","app.album_ratings","album_haven_readonly"]],
    [0,[false,"REFERENCES","app.album_ratings","album_haven_readonly"]],
    [0,[true,"SELECT","app.album_ratings","album_haven_readonly"]],
    [0,[false,"UPDATE","app.album_ratings","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_anchor","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_anchor","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_anchor","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_anchor","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_anchor","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_anchor","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_anchor","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_budget","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_budget","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_budget","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_budget","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_budget","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_budget","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_budget","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_run","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_run","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_run","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_run","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_run","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_run","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_run","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_run","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_run","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_session","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_session","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_session","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_session","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_session","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_session","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_session","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_session","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_session","album_haven_readonly"]],
    [0,[false,"DELETE","app.album_top_listening_settings","album_haven_app"]],
    [0,[true,"INSERT","app.album_top_listening_settings","album_haven_app"]],
    [0,[false,"REFERENCES","app.album_top_listening_settings","album_haven_app"]],
    [0,[true,"SELECT","app.album_top_listening_settings","album_haven_app"]],
    [0,[false,"TRIGGER","app.album_top_listening_settings","album_haven_app"]],
    [0,[false,"TRUNCATE","app.album_top_listening_settings","album_haven_app"]],
    [0,[false,"UPDATE","app.album_top_listening_settings","album_haven_app"]],
    [0,[true,"DELETE","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"INSERT","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"REFERENCES","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"SELECT","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"TRIGGER","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"TRUNCATE","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[true,"UPDATE","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[false,"DELETE","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"INSERT","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"REFERENCES","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"SELECT","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"TRIGGER","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"TRUNCATE","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"UPDATE","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_loss","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_loss","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_loss","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_loss","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_loss","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_loss","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_loss","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_capture_owner","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_capture_owner","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_capture_owner","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_owner","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_capture_owner","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_capture_owner","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_capture_owner","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_decoder_observation","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_decoder_observation","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_decoder_observation","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_decoder_observation","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_decoder_observation","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_decoder_observation","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_decoder_observation","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_edition_capture","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_edition_capture","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_edition_capture","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_edition_capture","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_edition_capture","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_edition_capture","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_edition_capture","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[false,"DELETE","integration.playback_edition_selection","album_haven_app"]],
    [0,[true,"INSERT","integration.playback_edition_selection","album_haven_app"]],
    [0,[false,"REFERENCES","integration.playback_edition_selection","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_edition_selection","album_haven_app"]],
    [0,[false,"TRIGGER","integration.playback_edition_selection","album_haven_app"]],
    [0,[false,"TRUNCATE","integration.playback_edition_selection","album_haven_app"]],
    [0,[true,"UPDATE","integration.playback_edition_selection","album_haven_app"]],
    [0,[true,"DELETE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"INSERT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"REFERENCES","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"TRIGGER","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"TRUNCATE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"INSERT","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"REFERENCES","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"TRIGGER","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"TRUNCATE","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[false,"REFERENCES","app.album_ratings","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[false,"DELETE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"INSERT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"REFERENCES","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"TRIGGER","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"TRUNCATE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_edition_selection","album_haven_migrator"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140],"direct:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308],"direct:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308],"direct:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,309,30,31,32,33,34,35,36,37,38,39,40,41,42,310,311,312,313,314,315,316,50,51,52,53,54,55,56,57,58,59,60,61,62,63,317,318,319,320,321,322,323,71,72,73,74,75,76,77,78,79,80,81,82,83,84,324,325,326,327,328,329,330,92,93,94,95,96,97,98,99,100,101,102,103,104,105,331,332,333,334,335,336,337,113,114,115,116,117,118,119,120,121,122,123,124,125,126,338,339,340,341,342,343,344,134,135,136,137,138,139,140],"separate-owner:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,309,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,345,346,347,348,349,350,351,176,177,178,179,180,181,182,36,37,38,39,40,41,42,310,311,312,313,314,315,316,50,51,52,53,54,55,56,57,58,59,60,61,62,63,317,318,319,320,321,322,323,71,72,73,74,75,76,77,78,79,80,81,82,83,84,324,325,326,327,328,329,330,92,93,94,95,96,97,98,183,184,185,186,187,188,189,352,353,354,355,356,357,358,197,198,199,200,201,202,203,204,205,206,207,208,209,210,359,360,361,362,363,364,365,218,219,220,221,222,223,224,225,226,227,228,229,230,231,366,367,368,369,370,371,372,239,240,241,242,243,244,245,99,100,101,102,103,104,105,331,332,333,334,335,336,337,113,114,115,116,117,118,119,120,121,122,123,124,125,126,338,339,340,341,342,343,344,134,135,136,137,138,139,140,246,247,248,249,250,251,252,373,374,375,376,377,378,379,260,261,262,263,264,265,266,267,268,269,270,271,272,273,380,381,382,383,384,385,386,281,282,283,284,285,286,287,288,289,290,291,292,293,294,387,388,389,390,391,392,393,302,303,304,305,306,307,308],"separate-owner:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,309,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,345,346,347,348,349,350,351,176,177,178,179,180,181,182,36,37,38,39,40,41,42,310,311,312,313,314,315,316,50,51,52,53,54,55,56,57,58,59,60,61,62,63,317,318,319,320,321,322,323,71,72,73,74,75,76,77,78,79,80,81,82,83,84,324,325,326,327,328,329,330,92,93,94,95,96,97,98,183,184,185,186,187,188,189,352,353,354,355,356,357,358,197,198,199,200,201,202,203,204,205,206,207,208,209,210,359,360,361,362,363,364,365,218,219,220,221,222,223,224,225,226,227,228,229,230,231,366,367,368,369,370,371,372,239,240,241,242,243,244,245,99,100,101,102,103,104,105,331,332,333,334,335,336,337,113,114,115,116,117,118,119,120,121,122,123,124,125,126,338,339,340,341,342,343,344,134,135,136,137,138,139,140,246,247,248,249,250,251,252,373,374,375,376,377,378,379,260,261,262,263,264,265,266,267,268,269,270,271,272,273,380,381,382,383,384,385,386,281,282,283,284,285,286,287,288,289,290,291,292,293,294,387,388,389,390,391,392,393,302,303,304,305,306,307,308],"separate-owner:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,309,30,31,32,33,34,35,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,345,346,347,348,349,350,351,176,177,178,179,180,181,182,36,37,38,39,40,41,42,310,311,312,313,314,315,316,50,51,52,53,54,55,56,57,58,59,60,61,62,63,317,318,319,320,321,322,323,71,72,73,74,75,76,77,78,79,80,81,82,83,84,324,325,326,327,328,329,330,92,93,94,95,96,97,98,183,184,185,186,187,188,189,352,353,354,355,356,357,358,197,198,199,200,201,202,203,204,205,206,207,208,209,210,359,360,361,362,363,364,365,218,219,220,221,222,223,224,225,226,227,228,229,230,231,366,367,368,369,370,371,372,239,240,241,242,243,244,245,99,100,101,102,103,104,105,331,332,333,334,335,336,337,113,114,115,116,117,118,119,120,121,122,123,124,125,126,338,339,340,341,342,343,344,134,135,136,137,138,139,140,246,247,248,249,250,251,252,373,374,375,376,377,378,379,260,261,262,263,264,265,266,267,268,269,270,271,272,273,380,381,382,383,384,385,386,281,282,283,284,285,286,287,288,289,290,291,292,293,294,387,388,389,390,391,392,393,302,303,304,305,306,307,308]}},
  "effective_schema":{"fields":[["create_allowed","migration_membership","named_migrator_membership","role","schema","usage"]],"rows":[
    [0,[false,false,false,"album_haven_app","app",true]],
    [0,[true,null,null,"album_haven_migrator","app",true]],
    [0,[false,false,false,"album_haven_readonly","app",true]],
    [0,[false,false,false,"album_haven_app","integration",true]],
    [0,[true,null,null,"album_haven_migrator","integration",true]],
    [0,[false,false,false,"album_haven_readonly","integration",true]],
    [0,[false,null,null,"album_haven_migrator","app",false]],
    [0,[false,null,null,"album_haven_migrator","integration",false]]
  ],"states":{"direct:C0":[0,1,2,3,4,5],"direct:C9":[0,1,2,3,4,5],"direct:CA":[0,1,2,3,4,5],"direct:CF":[0,1,2,3,4,5],"separate-owner:C0":[0,6,2,3,7,5],"separate-owner:C9":[0,6,2,3,7,5],"separate-owner:CA":[0,6,2,3,7,5],"separate-owner:CF":[0,6,2,3,7,5]}},
  "effective_column":{"fields":[["allowed_columns","privilege","relation","role"]],"rows":[
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"INSERT","integration.playback_capture_anchor","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_anchor","album_haven_app"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"SELECT","integration.playback_capture_anchor","album_haven_app"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"UPDATE","integration.playback_capture_anchor","album_haven_app"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"INSERT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"REFERENCES","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"SELECT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"UPDATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[["account_budget_id","epoch","id","max_quantum_frames","monotonic_probe_span_ms","output_frame","probe_id","quality","reservation_bytes","session_id","utc_lower_ms","utc_upper_ms"],"SELECT","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_anchor","album_haven_readonly"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"INSERT","integration.playback_capture_budget","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_budget","album_haven_app"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"SELECT","integration.playback_capture_budget","album_haven_app"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"UPDATE","integration.playback_capture_budget","album_haven_app"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"INSERT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"REFERENCES","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"SELECT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"UPDATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[["account_id","id","is_global","rate_tokens","rate_updated_at","reserved_bytes"],"SELECT","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_budget","album_haven_readonly"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"INSERT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"UPDATE","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"INSERT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"REFERENCES","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"UPDATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"INSERT","integration.playback_capture_run","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"SELECT","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"UPDATE","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"INSERT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"REFERENCES","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"SELECT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"UPDATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_run","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_run","album_haven_readonly"]],
    [0,[["account_budget_id","anchor_after","anchor_before","checkpoint_id","epoch","frames","id","ordinal_start","output_start","quality","reservation_bytes","run_index","source_start48"],"SELECT","integration.playback_capture_run","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_run","album_haven_readonly"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"INSERT","integration.playback_capture_session","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"UPDATE","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"INSERT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"REFERENCES","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"UPDATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_session","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_session","album_haven_readonly"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_session","album_haven_readonly"]],
    [0,[["listening_baseline_at","listening_item_ref"],"INSERT","app.album_list_item_progress","album_haven_app"]],
    [0,[[],"REFERENCES","app.album_list_item_progress","album_haven_app"]],
    [0,[["listening_baseline_at","listening_item_ref"],"SELECT","app.album_list_item_progress","album_haven_app"]],
    [0,[["listening_baseline_at","listening_item_ref"],"UPDATE","app.album_list_item_progress","album_haven_app"]],
    [0,[["listening_baseline_at","listening_item_ref"],"INSERT","app.album_list_item_progress","album_haven_migrator"]],
    [0,[["listening_baseline_at","listening_item_ref"],"REFERENCES","app.album_list_item_progress","album_haven_migrator"]],
    [0,[["listening_baseline_at","listening_item_ref"],"SELECT","app.album_list_item_progress","album_haven_migrator"]],
    [0,[["listening_baseline_at","listening_item_ref"],"UPDATE","app.album_list_item_progress","album_haven_migrator"]],
    [0,[[],"INSERT","app.album_list_item_progress","album_haven_readonly"]],
    [0,[[],"REFERENCES","app.album_list_item_progress","album_haven_readonly"]],
    [0,[[],"SELECT","app.album_list_item_progress","album_haven_readonly"]],
    [0,[[],"UPDATE","app.album_list_item_progress","album_haven_readonly"]],
    [0,[["listening_baseline_at"],"INSERT","app.album_list_items","album_haven_app"]],
    [0,[[],"REFERENCES","app.album_list_items","album_haven_app"]],
    [0,[["listening_baseline_at"],"SELECT","app.album_list_items","album_haven_app"]],
    [0,[["listening_baseline_at"],"UPDATE","app.album_list_items","album_haven_app"]],
    [0,[["listening_baseline_at"],"INSERT","app.album_list_items","album_haven_migrator"]],
    [0,[["listening_baseline_at"],"REFERENCES","app.album_list_items","album_haven_migrator"]],
    [0,[["listening_baseline_at"],"SELECT","app.album_list_items","album_haven_migrator"]],
    [0,[["listening_baseline_at"],"UPDATE","app.album_list_items","album_haven_migrator"]],
    [0,[[],"INSERT","app.album_list_items","album_haven_readonly"]],
    [0,[[],"REFERENCES","app.album_list_items","album_haven_readonly"]],
    [0,[[],"SELECT","app.album_list_items","album_haven_readonly"]],
    [0,[[],"UPDATE","app.album_list_items","album_haven_readonly"]],
    [0,[["native_rating_intent_at"],"INSERT","app.album_ratings","album_haven_app"]],
    [0,[[],"REFERENCES","app.album_ratings","album_haven_app"]],
    [0,[["native_rating_intent_at"],"SELECT","app.album_ratings","album_haven_app"]],
    [0,[["native_rating_intent_at"],"UPDATE","app.album_ratings","album_haven_app"]],
    [0,[["native_rating_intent_at"],"INSERT","app.album_ratings","album_haven_migrator"]],
    [0,[["native_rating_intent_at"],"REFERENCES","app.album_ratings","album_haven_migrator"]],
    [0,[["native_rating_intent_at"],"SELECT","app.album_ratings","album_haven_migrator"]],
    [0,[["native_rating_intent_at"],"UPDATE","app.album_ratings","album_haven_migrator"]],
    [0,[[],"INSERT","app.album_ratings","album_haven_readonly"]],
    [0,[[],"REFERENCES","app.album_ratings","album_haven_readonly"]],
    [0,[["native_rating_intent_at"],"SELECT","app.album_ratings","album_haven_readonly"]],
    [0,[[],"UPDATE","app.album_ratings","album_haven_readonly"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"INSERT","app.album_top_listening_settings","album_haven_app"]],
    [0,[[],"REFERENCES","app.album_top_listening_settings","album_haven_app"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"SELECT","app.album_top_listening_settings","album_haven_app"]],
    [0,[["completed_target","revision","updated_at"],"UPDATE","app.album_top_listening_settings","album_haven_app"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"INSERT","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"REFERENCES","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"SELECT","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[["account_id","completed_target","created_at","revision","updated_at"],"UPDATE","app.album_top_listening_settings","album_haven_migrator"]],
    [0,[[],"INSERT","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[[],"REFERENCES","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[[],"SELECT","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[[],"UPDATE","app.album_top_listening_settings","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"INSERT","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"SELECT","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"UPDATE","integration.playback_album_metrics_state","album_haven_app"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"INSERT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"REFERENCES","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"SELECT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"UPDATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","original_album_id","original_library_id","reservation_bytes","state","state_revision","updated_at"],"SELECT","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_album_metrics_state","album_haven_readonly"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"INSERT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"UPDATE","integration.playback_capture_checkpoint","album_haven_app"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"INSERT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"REFERENCES","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"UPDATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[["accepted_at","account_budget_id","digest","evidence","evidence_redacted","id","known_frames","lost_frames","receipt_body","receipt_status","reservation_bytes","sequence","session_id","terminal","terminal_reason"],"SELECT","integration.playback_capture_checkpoint","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"INSERT","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"SELECT","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"UPDATE","integration.playback_capture_history_revision","album_haven_app"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"INSERT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"REFERENCES","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"SELECT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"UPDATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","append_revision","invalidation_revision","proof_revision","raw_checkpoint_cut","reservation_bytes"],"SELECT","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_history_revision","album_haven_readonly"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"INSERT","integration.playback_capture_loss","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_loss","album_haven_app"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"SELECT","integration.playback_capture_loss","album_haven_app"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"UPDATE","integration.playback_capture_loss","album_haven_app"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"INSERT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"REFERENCES","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"SELECT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"UPDATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[["account_budget_id","checkpoint_id","gap_index","id","ordinal_end","ordinal_start","output_end","output_start","owner_id","reservation_bytes"],"SELECT","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_loss","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"INSERT","integration.playback_capture_owner","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_capture_owner","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"SELECT","integration.playback_capture_owner","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"UPDATE","integration.playback_capture_owner","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"INSERT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"REFERENCES","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"SELECT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"UPDATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","auth_session_guard","device_uuid","id","library_id","owner_uuid","reservation_bytes"],"SELECT","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_capture_owner","album_haven_readonly"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"INSERT","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"SELECT","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"UPDATE","integration.playback_capture_run","album_haven_app"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"INSERT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"REFERENCES","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"SELECT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"UPDATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[["account_budget_id","anchor_after","anchor_before","binding_serial","checkpoint_id","continuity_serial","epoch","frames","generation","id","ordinal_start","output_start","owner_id","quality","reservation_bytes","run_index","source_base48","source_start48","stream_id"],"SELECT","integration.playback_capture_run","album_haven_readonly"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"INSERT","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"UPDATE","integration.playback_capture_session","album_haven_app"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"INSERT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"REFERENCES","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"UPDATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[["accepted_known_frames","accepted_lost_frames","account_budget_id","account_id","admitted_at","anchor_count","auth_session_guard","capture_uuid","device_uuid","disc_number","evidence_version","has_gaps","id","last_activity_at","last_known_ordinal_end","last_known_output_end","last_sequence","library_id","live_album_id","live_track_id","ordinal_end","ordinal_start","original_album_id","original_file_id","original_root_id","original_track_id","owner_id","owner_uuid","reservation_bytes","terminal_at","terminal_reason","timing_unknown","track_number","v1_session_uuid"],"SELECT","integration.playback_capture_session","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"INSERT","integration.playback_decoder_observation","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_decoder_observation","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"SELECT","integration.playback_decoder_observation","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"UPDATE","integration.playback_decoder_observation","album_haven_app"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"INSERT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"REFERENCES","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"SELECT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"UPDATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","auth_session_guard","coordinate_basis","extent_frames48","generation","inventory_source_revision","observation_ref","observed_at","original_file_id","original_library_id","original_root_id","original_track_id","requested_start48","reservation_bytes","source_base48","stream_id"],"SELECT","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_decoder_observation","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"INSERT","integration.playback_edition_capture","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_edition_capture","album_haven_app"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_capture","album_haven_app"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"UPDATE","integration.playback_edition_capture","album_haven_app"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"INSERT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"REFERENCES","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"UPDATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","live_capture_session_id","original_capture_session_id","original_track_id","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_edition_capture","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"INSERT","integration.playback_edition_selection","album_haven_app"]],
    [0,[[],"REFERENCES","integration.playback_edition_selection","album_haven_app"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_selection","album_haven_app"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"UPDATE","integration.playback_edition_selection","album_haven_app"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"INSERT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"REFERENCES","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"UPDATE","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[[],"REFERENCES","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[["account_budget_id","account_id","canonical_membership","created_at","membership_revision","original_album_id","original_library_id","originating_session_id","provenance","reservation_bytes","selection_ref"],"SELECT","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[[],"UPDATE","integration.playback_edition_selection","album_haven_readonly"]],
    [0,[[],"INSERT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_anchor","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_budget","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_checkpoint","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_run","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_run","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_run","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_session","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_session","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_session","album_haven_migrator"]],
    [0,[[],"REFERENCES","app.album_ratings","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_album_metrics_state","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_history_revision","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_loss","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_capture_owner","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_decoder_observation","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_edition_capture","album_haven_migrator"]],
    [0,[[],"INSERT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[[],"REFERENCES","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[[],"SELECT","integration.playback_edition_selection","album_haven_migrator"]],
    [0,[[],"UPDATE","integration.playback_edition_selection","album_haven_migrator"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59],"direct:C9":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,120,25,121,122,123,124,125,126,32,33,127,35,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,37,165,166,167,168,169,170,44,45,171,47,172,49,173,174,175,176,177,178,56,57,179,59,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215],"direct:CA":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,120,25,121,122,123,124,125,126,32,33,127,35,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,37,165,166,167,168,169,170,44,45,171,47,172,49,173,174,175,176,177,178,56,57,179,59,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215],"direct:CF":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,120,25,121,122,123,124,125,126,32,33,127,35,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,37,165,166,167,168,169,170,44,45,171,47,172,49,173,174,175,176,177,178,56,57,179,59,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215],"separate-owner:C0":[0,1,2,3,216,217,218,219,8,9,10,11,12,13,14,15,220,221,222,223,20,21,22,23,24,25,26,27,224,225,226,227,32,33,34,35,36,37,38,39,228,229,230,231,44,45,46,47,48,49,50,51,232,233,234,235,56,57,58,59],"separate-owner:C9":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,236,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,237,238,239,240,116,117,118,119,0,1,2,3,216,217,218,219,8,9,10,11,12,13,14,15,220,221,222,223,20,21,22,23,120,25,121,122,224,225,226,227,32,33,127,35,128,129,130,131,241,242,243,244,136,137,138,139,140,141,142,143,245,246,247,248,148,149,150,151,152,153,154,155,249,250,251,252,160,161,162,163,164,37,165,166,228,229,230,231,44,45,171,47,172,49,173,174,232,233,234,235,56,57,179,59,180,181,182,183,253,254,255,256,188,189,190,191,192,193,194,195,257,258,259,260,200,201,202,203,204,205,206,207,261,262,263,264,212,213,214,215],"separate-owner:CA":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,236,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,237,238,239,240,116,117,118,119,0,1,2,3,216,217,218,219,8,9,10,11,12,13,14,15,220,221,222,223,20,21,22,23,120,25,121,122,224,225,226,227,32,33,127,35,128,129,130,131,241,242,243,244,136,137,138,139,140,141,142,143,245,246,247,248,148,149,150,151,152,153,154,155,249,250,251,252,160,161,162,163,164,37,165,166,228,229,230,231,44,45,171,47,172,49,173,174,232,233,234,235,56,57,179,59,180,181,182,183,253,254,255,256,188,189,190,191,192,193,194,195,257,258,259,260,200,201,202,203,204,205,206,207,261,262,263,264,212,213,214,215],"separate-owner:CF":[60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,236,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,237,238,239,240,116,117,118,119,0,1,2,3,216,217,218,219,8,9,10,11,12,13,14,15,220,221,222,223,20,21,22,23,120,25,121,122,224,225,226,227,32,33,127,35,128,129,130,131,241,242,243,244,136,137,138,139,140,141,142,143,245,246,247,248,148,149,150,151,152,153,154,155,249,250,251,252,160,161,162,163,164,37,165,166,228,229,230,231,44,45,171,47,172,49,173,174,232,233,234,235,56,57,179,59,180,181,182,183,253,254,255,256,188,189,190,191,192,193,194,195,257,258,259,260,200,201,202,203,204,205,206,207,261,262,263,264,212,213,214,215]}},
  "effective_sequence":{"fields":[["allowed","privilege","relation","role"]],"rows":[
    [0,[true,"SELECT","integration.playback_capture_anchor_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_anchor_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_anchor_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_anchor_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_anchor_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_anchor_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_budget_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_budget_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_budget_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_budget_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_budget_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_budget_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_checkpoint_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_checkpoint_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_checkpoint_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_checkpoint_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_checkpoint_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_run_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_run_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_run_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_run_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_run_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_run_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_session_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_session_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_session_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_session_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_session_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_session_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_loss_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_loss_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_loss_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_loss_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_loss_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_loss_id_seq","album_haven_readonly"]],
    [0,[true,"SELECT","integration.playback_capture_owner_id_seq","album_haven_app"]],
    [0,[false,"UPDATE","integration.playback_capture_owner_id_seq","album_haven_app"]],
    [0,[true,"USAGE","integration.playback_capture_owner_id_seq","album_haven_app"]],
    [0,[true,"SELECT","integration.playback_capture_owner_id_seq","album_haven_migrator"]],
    [0,[true,"UPDATE","integration.playback_capture_owner_id_seq","album_haven_migrator"]],
    [0,[true,"USAGE","integration.playback_capture_owner_id_seq","album_haven_migrator"]],
    [0,[true,"SELECT","integration.playback_capture_owner_id_seq","album_haven_readonly"]],
    [0,[false,"UPDATE","integration.playback_capture_owner_id_seq","album_haven_readonly"]],
    [0,[false,"USAGE","integration.playback_capture_owner_id_seq","album_haven_readonly"]],
    [0,[false,"SELECT","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_anchor_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_budget_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_checkpoint_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_run_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_session_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_loss_id_seq","album_haven_migrator"]],
    [0,[false,"SELECT","integration.playback_capture_owner_id_seq","album_haven_migrator"]],
    [0,[false,"UPDATE","integration.playback_capture_owner_id_seq","album_haven_migrator"]],
    [0,[false,"USAGE","integration.playback_capture_owner_id_seq","album_haven_migrator"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44],"direct:C9":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44],"direct:CA":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44],"direct:CF":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44],"separate-owner:C0":[0,1,2,63,64,65,6,7,8,9,10,11,66,67,68,15,16,17,18,19,20,69,70,71,24,25,26,27,28,29,72,73,74,33,34,35,36,37,38,75,76,77,42,43,44],"separate-owner:C9":[0,1,2,63,64,65,6,7,8,9,10,11,66,67,68,15,16,17,18,19,20,69,70,71,24,25,26,45,46,47,78,79,80,51,52,53,54,55,56,81,82,83,60,61,62,27,28,29,72,73,74,33,34,35,36,37,38,75,76,77,42,43,44],"separate-owner:CA":[0,1,2,63,64,65,6,7,8,9,10,11,66,67,68,15,16,17,18,19,20,69,70,71,24,25,26,45,46,47,78,79,80,51,52,53,54,55,56,81,82,83,60,61,62,27,28,29,72,73,74,33,34,35,36,37,38,75,76,77,42,43,44],"separate-owner:CF":[0,1,2,63,64,65,6,7,8,9,10,11,66,67,68,15,16,17,18,19,20,69,70,71,24,25,26,45,46,47,78,79,80,51,52,53,54,55,56,81,82,83,60,61,62,27,28,29,72,73,74,33,34,35,36,37,38,75,76,77,42,43,44]}},
  "effective_function":{"fields":[["allowed","identity","role"]],"rows":[
    [0,[false,"app._artwork_publication_closure_guard()","album_haven_app"]],
    [0,[true,"app._artwork_publication_closure_guard()","album_haven_migrator"]],
    [0,[false,"app._artwork_publication_closure_guard()","album_haven_readonly"]],
    [0,[false,"app.guard_album_top_source_structure()","album_haven_app"]],
    [0,[true,"app.guard_album_top_source_structure()","album_haven_migrator"]],
    [0,[false,"app.guard_album_top_source_structure()","album_haven_readonly"]],
    [0,[false,"app.invalidate_home_album_taste()","album_haven_app"]],
    [0,[true,"app.invalidate_home_album_taste()","album_haven_migrator"]],
    [0,[false,"app.invalidate_home_album_taste()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_anonymize()","album_haven_app"]],
    [0,[true,"integration.playback_capture_anonymize()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_anonymize()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_release_charge()","album_haven_app"]],
    [0,[true,"integration.playback_capture_release_charge()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_release_charge()","album_haven_readonly"]],
    [0,[true,"app.guard_album_top_listening_settings()","album_haven_app"]],
    [0,[true,"app.guard_album_top_listening_settings()","album_haven_migrator"]],
    [0,[false,"app.guard_album_top_listening_settings()","album_haven_readonly"]],
    [0,[true,"integration.playback_album_metrics_state_guard()","album_haven_app"]],
    [0,[true,"integration.playback_album_metrics_state_guard()","album_haven_migrator"]],
    [0,[true,"integration.playback_album_metrics_state_guard()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_history_check_revision()","album_haven_app"]],
    [0,[true,"integration.playback_capture_history_check_revision()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_history_check_revision()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_history_guard_revision()","album_haven_app"]],
    [0,[true,"integration.playback_capture_history_guard_revision()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_history_guard_revision()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_history_invalidate(bigint)","album_haven_app"]],
    [0,[true,"integration.playback_capture_history_invalidate(bigint)","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_history_invalidate(bigint)","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_history_raw_mutation()","album_haven_app"]],
    [0,[true,"integration.playback_capture_history_raw_mutation()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_history_raw_mutation()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_assert_anchor(bigint)","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_assert_anchor(bigint)","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_assert_anchor(bigint)","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_assert_checkpoint(bigint,boolean)","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_assert_checkpoint(bigint,boolean)","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_assert_checkpoint(bigint,boolean)","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_assert_run(bigint)","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_assert_run(bigint)","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_assert_run(bigint)","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_assert_session(bigint)","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_assert_session(bigint)","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_assert_session(bigint)","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_check_graph()","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_check_graph()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_check_graph()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_cleanup_owner()","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_cleanup_owner()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_cleanup_owner()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_guard_checkpoint()","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_guard_checkpoint()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_guard_checkpoint()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_guard_owner()","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_guard_owner()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_guard_owner()","album_haven_readonly"]],
    [0,[true,"integration.playback_capture_v2_guard_session()","album_haven_app"]],
    [0,[true,"integration.playback_capture_v2_guard_session()","album_haven_migrator"]],
    [0,[true,"integration.playback_capture_v2_guard_session()","album_haven_readonly"]],
    [0,[true,"integration.playback_decoder_observation_guard()","album_haven_app"]],
    [0,[true,"integration.playback_decoder_observation_guard()","album_haven_migrator"]],
    [0,[true,"integration.playback_decoder_observation_guard()","album_haven_readonly"]],
    [0,[true,"integration.playback_decoder_observation_invalidate()","album_haven_app"]],
    [0,[true,"integration.playback_decoder_observation_invalidate()","album_haven_migrator"]],
    [0,[true,"integration.playback_decoder_observation_invalidate()","album_haven_readonly"]],
    [0,[true,"integration.playback_edition_guard()","album_haven_app"]],
    [0,[true,"integration.playback_edition_guard()","album_haven_migrator"]],
    [0,[true,"integration.playback_edition_guard()","album_haven_readonly"]],
    [0,[true,"integration.playback_edition_unlink_revision()","album_haven_app"]],
    [0,[true,"integration.playback_edition_unlink_revision()","album_haven_migrator"]],
    [0,[true,"integration.playback_edition_unlink_revision()","album_haven_readonly"]],
    [0,[false,"app._artwork_publication_closure_guard()","album_haven_migrator"]],
    [0,[false,"app.guard_album_top_source_structure()","album_haven_migrator"]],
    [0,[false,"app.invalidate_home_album_taste()","album_haven_migrator"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14],"direct:C9":[0,1,2,15,16,17,3,4,5,6,7,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71],"direct:CA":[0,1,2,15,16,17,3,4,5,6,7,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71],"direct:CF":[0,1,2,15,16,17,3,4,5,6,7,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71],"separate-owner:C0":[0,72,2,3,73,5,6,74,8,9,10,11,12,13,14],"separate-owner:C9":[0,72,2,15,16,17,3,73,5,6,74,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71],"separate-owner:CA":[0,72,2,15,16,17,3,73,5,6,74,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71],"separate-owner:CF":[0,72,2,15,16,17,3,73,5,6,74,8,18,19,20,9,10,11,21,22,23,24,25,26,27,28,29,30,31,32,12,13,14,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71]}},
  "feature_identities":{"fields":[["relkind","relname","schema"]],"rows":[
    [0,["i","playback_capture_active_owner","integration"]],
    [0,["r","playback_capture_anchor","integration"]],
    [0,["S","playback_capture_anchor_id_seq","integration"]],
    [0,["i","playback_capture_anchor_pkey","integration"]],
    [0,["i","playback_capture_anchor_session_id_epoch_probe_id_key","integration"]],
    [0,["r","playback_capture_budget","integration"]],
    [0,["i","playback_capture_budget_account_id_key","integration"]],
    [0,["S","playback_capture_budget_id_seq","integration"]],
    [0,["i","playback_capture_budget_pkey","integration"]],
    [0,["r","playback_capture_checkpoint","integration"]],
    [0,["S","playback_capture_checkpoint_id_seq","integration"]],
    [0,["i","playback_capture_checkpoint_pkey","integration"]],
    [0,["i","playback_capture_checkpoint_session_id_sequence_key","integration"]],
    [0,["i","playback_capture_one_global_budget","integration"]],
    [0,["i","playback_capture_owned_identity","integration"]],
    [0,["r","playback_capture_run","integration"]],
    [0,["i","playback_capture_run_checkpoint_id_run_index_key","integration"]],
    [0,["S","playback_capture_run_id_seq","integration"]],
    [0,["i","playback_capture_run_pkey","integration"]],
    [0,["r","playback_capture_session","integration"]],
    [0,["S","playback_capture_session_id_seq","integration"]],
    [0,["i","playback_capture_session_pkey","integration"]],
    [0,["r","album_top_listening_settings","app"]],
    [0,["i","album_top_listening_settings_pkey","app"]],
    [0,["r","playback_album_metrics_state","integration"]],
    [0,["i","playback_album_metrics_state_pkey","integration"]],
    [0,["i","playback_capture_account_session_history","integration"]],
    [0,["r","playback_capture_history_revision","integration"]],
    [0,["i","playback_capture_history_revision_budget_ref","integration"]],
    [0,["i","playback_capture_history_revision_pkey","integration"]],
    [0,["r","playback_capture_loss","integration"]],
    [0,["i","playback_capture_loss_budget_ref","integration"]],
    [0,["i","playback_capture_loss_checkpoint_id_gap_index_key","integration"]],
    [0,["S","playback_capture_loss_id_seq","integration"]],
    [0,["i","playback_capture_loss_owner_ordinal_range","integration"]],
    [0,["i","playback_capture_loss_owner_output_range","integration"]],
    [0,["i","playback_capture_loss_owner_ref","integration"]],
    [0,["i","playback_capture_loss_pkey","integration"]],
    [0,["r","playback_capture_owner","integration"]],
    [0,["i","playback_capture_owner_account_id_library_id_device_uuid_au_key","integration"]],
    [0,["S","playback_capture_owner_id_seq","integration"]],
    [0,["i","playback_capture_owner_local_metrics_page","integration"]],
    [0,["i","playback_capture_owner_pkey","integration"]],
    [0,["i","playback_capture_run_owner_binding","integration"]],
    [0,["i","playback_capture_run_owner_ordinal","integration"]],
    [0,["i","playback_capture_session_local_album","integration"]],
    [0,["i","playback_capture_session_owner_ref","integration"]],
    [0,["r","playback_decoder_observation","integration"]],
    [0,["i","playback_decoder_observation_local_version_extent","integration"]],
    [0,["i","playback_decoder_observation_pkey","integration"]],
    [0,["r","playback_edition_capture","integration"]],
    [0,["i","playback_edition_capture_budget","integration"]],
    [0,["i","playback_edition_capture_live","integration"]],
    [0,["i","playback_edition_capture_pkey","integration"]],
    [0,["i","playback_edition_capture_selection_ref","integration"]],
    [0,["r","playback_edition_selection","integration"]],
    [0,["i","playback_edition_selection_budget","integration"]],
    [0,["i","playback_edition_selection_pkey","integration"]]
  ],"states":{"direct:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21],"direct:C9":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57],"direct:CA":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57],"direct:CF":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57],"separate-owner:C0":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21],"separate-owner:C9":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57],"separate-owner:CA":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57],"separate-owner:CF":[22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,27,28,29,30,31,32,33,34,35,36,37,13,14,38,39,40,41,42,15,16,17,43,44,18,19,20,45,46,21,47,48,49,50,51,52,53,54,55,56,57]}},
  "installer":{"fields":[["named_migrator_membership","owner","rolbypassrls","rolcreatedb","rolcreaterole","rolreplication","rolsuper","same_session","session_bypassrls","session_createdb","session_createrole","session_replication","session_superuser","topology"]],"rows":[
    [0,[true,"$migration_owner",false,false,false,false,false,true,false,false,false,false,false,"direct"]],
    [0,[true,"$migration_owner",false,false,false,false,false,true,false,false,false,false,false,"separate-owner"]]
  ],"states":{"direct:C0":[0],"direct:C9":[0],"direct:CA":[0],"direct:CF":[0],"separate-owner:C0":[1],"separate-owner:C9":[1],"separate-owner:CA":[1],"separate-owner:CF":[1]}}
}$catalog_contract$::jsonb;
  inventories constant jsonb := $inventory_contract${"153":{"0001_create_current_stack_schemas.sql":"af99fb5d41b9be2ff0bf45de2498f119a350bc2b0506318ed9b81b94706b910b","0002_create_local_mbid_assertions.sql":"208375e5e989b1aa7f002aecea08287472f57568568831903906eb9bffed9903","0003_add_local_mbid_projection_provenance.sql":"fcedd2adeed579e356edae4267eef1c88b1459baa1f29bcecbcee9c098c7755e","0004_add_lastfm_backfill_identities.sql":"8c86d3d439c6278692d6cae6f0a755568727f1dfe168686ddf791e5e79bc3ed8","0005_add_policy_context_hooks.sql":"1b174c1f1c3b0ca517fadb4592664c0c4625aa241689c8442362910ce9c39114","0006_scope_lastfm_sync_identities.sql":"b4c4a574cb1b5843b9099164961269223e844c2f3791e2afbc01ee0c9c9a472e","0007_scope_cover_lookup_task_identities.sql":"69584ccb7fe5850f0669dcdc6d191fab42904e98cc9c598459f71e7f060e87fc","0008_scope_saved_loop_identities.sql":"7c01ff55400c07e283628db91f94f0c68aac4ef07bd7850a1e98c98c7de86e3d","0009_create_user_discovery_preferences.sql":"50f405733b78aee5b63537e27c4b93b5c9557c243061030fd735f686fe67513f","0010_create_virtual_artist_snapshots.sql":"815c0ab009ce17f45bc41ff2a020036391406129450241d03be7fa86c9eaeee0","0011_create_log_history.sql":"834bfa7cfc219147652dc4f65dc326a88ab3f045ba65e80b1763cb79329c5215","0012_create_discovery_lookup_snapshots.sql":"26972a468722187dddb661c0aa8b95c6dcf0cf13640c52138c03299658f96435","0013_create_virtual_release_snapshots.sql":"ed7a7a15e4fc3f504870cfecd32e65e1694bb5677946d26e51fb8052c7571426","0014_update_bootstrap_owner_nominem.sql":"5f2fc3abfcaf763675e23436619988226c705d894be7ff28233e9ce3804026e1","0015_create_local_artist_family_links.sql":"643da57e5e8fd09a01580e4c032456af09a2b5813510e28dc7455763128c5777","0016_grant_local_artist_family_link_delete.sql":"9ca52401a68f02b93e00b51c8cea449e535e1fdc4111b549218f0fdf8c546b6b","0017_create_e2e_problematic_fixture_seeds.sql":"5f7764bf70a662da7967be3f02eb7c3870beb5e8ce4128315bd9e76826f1d96c","0018_repair_saved_loop_relations.sql":"232246fb993730d6ee32ee25daa5bf4267ffd960a4cb3c96058b040526ef7e37","0019_create_local_album_featured_artists.sql":"e8fce82f15dde806a635cb75959682824076de761ca9aef325a18ee31202ad51","0020_grant_runtime_delete_privileges.sql":"c0b09ea21d750c78e57b02692909f4bfbf144199799e7f02e4126e46b60a21c2","0021_add_problematic_file_generated_projection.sql":"2bb2cfccf2857668e12878cbd3d7ff2c9f9183128a0efcad001ea4a78ba94165","0022_fix_lastfm_pending_scrobble_conflict_identity.sql":"826db54bcd53c0d98bcf3b4bcf93e9324d3c942f6b616856541310daf49ead6d","0023_link_local_track_files_to_library_roots.sql":"f8a54b65a728e7baa4c751a4d7ca3a7a0d9b33ef0bc0d9b8ed03358259dcfe4f","0024_add_library_search_trigram_indexes.sql":"a1384a9b7f772523240a5d273c29f65f66a7c68033889471ab860b073a6dc94f","0025_grant_local_album_featured_artist_delete.sql":"4bf60d815f8bf190b6e38537c61b8c590839a60bb0b45b726cc9496cdf2d56b1","0026_create_album_ratings.sql":"ecffed81f62181097051b4750fffecf44b929ee871cd60d32035b198817f2279","0027_repair_cover_lookup_task_delete_grant.sql":"e6f714bffaa2a22dc4119cfff5b72435d8fbc4791e44599a06a452aeac8d8a7b","0028_repair_cover_lookup_task_conflict_identity.sql":"69584ccb7fe5850f0669dcdc6d191fab42904e98cc9c598459f71e7f060e87fc","0029_repair_lastfm_session_conflict_identity.sql":"7bb65105491a61ae3c16a568e008d0087b3888aa0a0a584fe7359ef20113b556","0030_drop_log_history.sql":"8f904e02775f36c1b4d8c685cbd46540046edc6593ea234202d58ca0d08d93b3","0031_add_problematic_active_track_index.sql":"d33841c3a6831d31e59edce881782c87bda966641847e5378698609deb53b564","0032_expand_problematic_active_track_index.sql":"1bbc0d9f1390459b383469ba7359c841e9c432c68f11b8bd6108d2c922f336a6","0033_repair_section14_album_identity_corruption.sql":"e4611cbdd0e728becf2cc249109d897934f24ddef4660337d25ae1b78e4483c7","0034_reconcile_semantic_local_albums.sql":"ac45c780cc0904f8ed9674bad80f7249dbcda9fe750698f76ab8e0afafcc2253","0035_enforce_semantic_local_album_identity.sql":"04a8b8e6223e87da079161af8e39d7e9eb1b3535e0b7b2d45f3d4b759318d588","0036_add_problematic_candidate_index.sql":"4c72e79b2b65ceda2f127cf05c7d30bc2d31ee8d762b75064650bc8b35a749db","0037_add_problematic_track_candidate_index.sql":"280c9787759d6596a597959e3ac868dad310287511d495f8c87963c2885c469d","0038_add_problematic_required_text_candidate.sql":"4e2fe1f16015cb8173029c0a670676d1470d3253d949a05d2b805b3af4719d1e","0039_repair_semantic_album_reconciliation_delete_grants.sql":"4725ee9b662c91b7dca3c82cfd4059fd5dfb822cfc8b7e8ce1e2db1606287f4b","0040_repair_ignored_repairs_delete_grant.sql":"b255a06f90fa0c4d91d4a5d98b4e77d62427fbedd039559388dda4cb454f255d","0041_create_local_album_cover_candidate_snapshots.sql":"83371681a280ed1644425b6766b8326bc730efebc653a37ca2a8e5c5bac76edd","0042_track_distinct_cover_improvement_alerts.sql":"cf9ead69b01515ceefabba345eb54eac75d34207b781122e34b43b3a5c438b6e","0043_create_local_track_waveform_peaks.sql":"6921c23429b7860640d4e68b0b7ebb3c1174d0c6cc23f55770dbd940f3e99dc1","0044_create_tag_edit_intents.sql":"1ba5105a870346687ecdfebd2f75fcad6b09e60fc784eee32c6ebf92c9946aec","0045_add_non_album_candidate_index.sql":"2ead0098e99335c0c15b0698b5f6039a356f8763f8ce26df03369e9103d4aa87","0046_add_local_auth_lifecycle.sql":"19a482f468566fd4f76b5625cfb5b1c373ff06f9c3aa5b447b5886662474c2ea","0047_add_auth_preauth_tokens.sql":"a18311d98e120a31db2e34da2d9a210c2bdeb41f979d1acb7a46684c638ec64e","0048_add_password_reset_transactions.sql":"84fd8348c1de715276ff047109c0650b67847e71d151fb5b61a808d64dd25df8","0049_enforce_single_use_password_reset_exchange.sql":"3644b833a3fd07dafcd1802673037de6db2a19c1f9a6fbc1dca0bded6dfe8b4d","0050_add_security_audit_cleanup_index.sql":"84f0d8591d59d7047dc65c1d24e34d5e74bef1847302e3b970e0c40e7224baaa","0051_add_auth_throttle_cleanup_index.sql":"a8fe9c9483040e445269e627f8ca25b0487435b7e45f2d88fd7fe9f88986e20a","0052_add_managed_account_invitations.sql":"527272f81f393be5c7fd32dd94031c13705912347ce476f45acb2cf3e2344c18","0053_create_user_appearance_preferences.sql":"31841a1f2413a3d2cc3cf5678b3ab23be1e12517d2487f2f5b7612b3738ce216","0054_add_appearance_palettes_and_player_colors.sql":"c875c2e1fea1f6228d0d0c3e843dba9cb18f49b56edaa2d8dbe65ca8b11b2167","0055_waveform_recent_colors.sql":"0f46853a5225cf8d338197ce645dd682fcee24eec2bc98b58030f583c2f92699","0056_compact_player_appearance_profiles.sql":"62082309e6ef9f53ffaa1c95fb18668d3a0399fc693430871dbf02bb67e30894","0057_aggregate_appearance_workspace.sql":"96da489ddf26a28e64a768fd74875b7b87c6fda0b215ccacb18e8edd67985620","0058_album_details_appearance.sql":"46cb63d33b77cee7672fd6a69c4a7dad6deca2a038b82ede14cd8f78979dca8f","0059_alert_appearance_family.sql":"a3f58a94a5fe96459264853e6adba03ea0dc4d97e01cfdb3f1e2c3daae8d6ab3","0060_player_aware_interaction_outline.sql":"01db8c6e5be72bd257dca4be188a09873fe93c651a47f528bf1e84e0ffee01c6","0061_create_missing_album_removal_function.sql":"3e32fceda6a21b2e0ed22fb1b2bb5076e0f1d22d435f3328b6f1f200c76315af","0062_narrow_readonly_account_privileges.sql":"70f3a4144c311825e1b8faba86215cfcffb50066bd0fa660bac1c04e91243584","0063_replace_missing_album_removal_lock_snapshot.sql":"95e706f18eca497273e65d2bfd3f7d11b8b2494340c8ff71f3c194641b0600da","0064_grant_library_membership_delete.sql":"3094a80b1c75578f632ee689681cf7949221a3780d9a7914ff6a23ea8a38964a","0065_native_player_component_provenance.sql":"ed39a4740063f715da2a4c1d40376250c0e1f0a0618d7da2efe01201308a31cf","0066_allow_appearance_panel_outline.sql":"3e1dd495f449a89da791f32c766703ba3b380d804431ea6a01bc378e14eb9744","0067_add_scanned_exception_candidate_index.sql":"7f91f559e34988f227a51b3cc3c15b0e1f128a4f7dd580277693c8f5ab46e342","0068_scoped_saved_loop_orders.sql":"0e621a844ccd081a809b3aa9b7a0d4ca96bed0ab68e5b1bc67900f7647fcda06","0069_scoped_operational_log_versions.sql":"800308a3200f11825becd4c9e4b373a469c27df1dbb63a201c8c5a4b3127d081","0070_appearance_loop_control_style.sql":"5e881cd776fbee018cc4ff3c61eae9b1fe95f6eb02a0c898007a5dd22ab2bf11","0071_allow_harbor_mint_appearance_palette.sql":"70fd5b42f5bc444f3f1a1493ffcd262cb9a138e0ffde4d897e036086354e8a04","0072_measured_local_listen_sessions.sql":"62bf0b7848facf2d70c72832c031af88066ca5c17607304ac2cf690f3c43bde4","0073_preserve_measured_listen_history.sql":"0789e51efc867b31693c343b86cfca8e9a037edd8c89c944b0df95e962250a67","0074_create_saved_loop_waveform_peaks.sql":"5ec365c4e993caf2d47b4e9e7cb42a4763231aa87d366c2ea811762a03c2b30d","0075_appearance_device_sections.sql":"4d34e1d97a6504bee08b82f9569cd448fa166fe2d4108e204b75462d8c029002","0076_docked_compact_player_behavior.sql":"05331b0ab76e629d810693423bd2d1a47a0ef97b5c5f3be51ed3e82aa134d5f1","0077_allow_parchment_pine_appearance_palette.sql":"0b05e82c6a0166e3231fcdd6057eed55a52b36df92de9cd8e80b450bd06ed4aa","0078_add_compact_player_motion_and_floating_edge.sql":"92ba922a46c39bd57a6ecca3099f05a1448ec08c70e6b4c785a5e4fc0067fd8d","0079_docked_compact_player_regular_style.sql":"621b473f3eb5738e3c463aafa34702c09a505746ee95b34072feadd425f96305","0080_user_client_layout_preferences.sql":"afa5cf574958b9bf04787c2e095d613e8168b6088096043e3435f75706fbfae4","0081_grant_move_policy_settings_delete.sql":"6736f051439f59e20431f7e772a1837e726d7f1822578740157aa92ed75591c0","0082_preserve_relations_for_missing_album_removal.sql":"4da41bd76f15b9d7c4e713ae696d4a89ae8fa044cda439ced9515fc0020853b3","0083_add_album_raw_artist_search_index.sql":"bdf32a924ab899e67da0fd4a927d23e26b936a79b22805a23c204dc816c3f810","0084_create_local_artist_search_projection.sql":"8b74086afda7b90bbfe6ca2e296c0b0cc9bc35e53e3d528d33c2a39d3d19c8b9","0085_add_stale_track_file_candidate_index.sql":"0c8c1fdd1dde3dbd0c0652931071ace0824397a7ecf73156ddd6d7ad7e14ad0f","0086_create_root_gallery_projection.sql":"653e18547d6d76d255e29af2f3a7dad65fd5b58d3e8f0da149c5ef5122119177","0087_reconcile_track_preferences_library_scope.sql":"36504b032406c6d2f471396ad0bf18470063a600a859608a6f8ca143ddb27888","0088_create_home_activity_snapshots.sql":"d4988f80c8fcfdf1711abc922660efd7d4ac298b7f9777702b275e39447df754","0089_create_owned_playlists.sql":"2ff9a5fbaaa9a3e745de3c1d28ee411e016118f7f0e90e4622ab68c875279010","0090_create_same_server_friends.sql":"18eb60d7f0d8201c52421fca8c4dd50b7a885a2f39c2940a0c7927745d5dbc6e","0091_playlist_collaboration.sql":"472dd6689b64db7d36e5139654a4898ec2d6d9d436f5622c57c81a2eb649b3b4","0092_playlist_settings.sql":"bb75619f91e99dfbc3567385dc256b1ad5617da50119b01193e47032faa7af46","0093_bind_home_activity_subjects.sql":"54c83be87a97ebe33858f4ad7ae5dbd21a63c4c854e4b6205420b229da3d9d91","0094_complete_playlist_selection_sources.sql":"1e4a7ecd20d1771a916534a5b3b48e83a85ab3a0c18aeb4c79f37be1af863cdf","0095_playlist_local_match_receipts.sql":"7056daedd0002a36d45218058de28f1bb632115acdbbe3935775776e044671fb","0096_create_current_playback_presence.sql":"6247efdb901fff233835c3edc8a0d0f996df90fb0473cab3200c8b8294277e0a","0100_playlist_viewer_actions.sql":"f7100d1ceb9df1ac7c550e28498fb63811523f1d6baf995e6b8e957ee5cfccc0","0101_create_album_top_artifacts.sql":"058b7e8a6f852fcafc9426216cc7513c3dd57ed74f65c037ac4df8c6e34325e3","0105_activity_missing_playlist_sources.sql":"4ed0363c23626f4ade36e9c9da3cfb0c487e64c0cb2ed940e0a9f2c8b79da57d","0106_playlist_copy_occurrences.sql":"6156d06f4c2552f81f91471087b6183fbc19c38672502831b6aad81ccc52e327","0107_allow_confirmed_catalog_album_versions.sql":"85f41ea9c9557d4d37cd804d0a995022bb5d7141d104819486f3e4c2e28e9a27","0108_album_top_collaboration.sql":"0a1aabe2d15386530f43d7967981e8a5fc69905cb6e51806e54ed29df1dc7820","0109_album_top_manual_progress.sql":"9e438752990b5365710a1ecd7e6f26f44a2a027200b147aed7eba3b5ab89ee42","0110_owner_save_top_publication.sql":"b616aa97c884f7a65915c3314df4eec07ead36fb9a82d7e99be42c13023fbd47","0111_owner_save_publication_seals.sql":"13ab0615f822efd24e0034513abd644cc854a2705b592fdf3745d9794f0d9680","0112_album_top_named_viewers.sql":"2bf1b800336b9573fa37e7e55dc47ea659bf5b80a3f8050850562cb40ab1829d","0113_popularity_source_observations.sql":"2b51da238430b2eac24be49f49a197ff671ce0970e70ffcecbd1e5536f238bbf","0114_intrinsic_personal_feature_access.sql":"fc22fd0b9f8d31dea72e502372e8c6b77ad78c3455025619e7804c4e710c690b","0115_playlist_library_mixes.sql":"691f238c5319e453c71f42ea478d8a932d3e497d8743d61c09cd15e0a1a3f91a","0116_local_track_popularity_mappings.sql":"e473c5c2ffd6c9f41c2c91e0f6d7596e3edcc901fdc29886fbad3cc395de52f4","0117_album_top_activity.sql":"7936ca297d73ec427e3572aa45626e770721bdfdfeacf7dc516700469e086692","0118_listening_goals.sql":"4f63b2cbfcfb4107deb931f3656b9e4da65fd99115f5a146110e125d382c9b18","0119_artist_popular_mix_scope.sql":"a561ac026c1005275beab9a5aa6db60629a46c9ea5380211e1dedcbc37b67cb9","0120_listening_goal_manual_membership.sql":"94a5c62074281f6a555c2ae24302784baf29170d2f4074001341427995383284","0121_listening_goal_bonus_settings.sql":"a4a2a23185ca7427bef7569461a66a036d8eba5073b7c3c2e932707053810e38","0122_listening_goal_bonus_draw.sql":"b8eb10905d09c43a493f4a252a7ee617df2bb9b64081b66b45e13e1f81bcb291","0123_listening_goal_period_transition.sql":"f5c497fd44bd3e8ee3a13f5242eab6939e6df51c5f5930143bc86d5484e1c71e","0124_listening_goal_attention.sql":"e826b52e390db3f6f2dfa3b971f511b2364a8411f4a30e29720204903af465db","0125_measured_listen_admission.sql":"e55645c8811684677dc8c072c74f50679d1c28441956f96c2a9e0247630f79e6","0126_private_top_artwork_preparation.sql":"d4fd8b5272296d02551b529b3eb6d1d9adb0a811b2aa1e4e4f4f949850bbc7e4","0127_private_top_remote_acquisition.sql":"b849fdb42550fe549561c9199eb87a3af3622003edb187ec08128e28ada99d65","0128_private_top_remote_membership.sql":"4b1147d3cc9e6d5071cb2867e496376361506c1ebba9143e36534dc84a34f639","0129_top_artwork_retention.sql":"d2c009885015b8503a192c9b1c9798c07b7e7aabdedb46ea3c9715285128fecd","0130_private_top_artwork_drafts.sql":"271d5b0926f24670d93a770bd66d33bea0d3a2cb97f11b3aa634d547f856c4d2","0131_top_artwork_completion_alias.sql":"da590b61b53beb58d6d920d939ad12d0d2fa2fbc54686776c680b4f5ed684e5d","0132_private_top_remote_preparations.sql":"437d7cf3722e313b112106c0919d6a28403e2fa769daab9f735b6c59435ffdfb","0133_private_top_remote_consumption.sql":"c433536b1600e706dd61fcda3fec9b8936cdccd9f1cb1b23acddac410c8d76bc","0134_private_top_artwork_draft_capture.sql":"a2226a26b9732d70a17af35d0054fba05e0306156dbed94d2c02e2b4c8c6c87e","0135_public_metadata_file_invalidation.sql":"818a4734aa6717efd0ff1aae96e583b6b2f00a52424fcde94f8af38f0014adc5","0136_private_top_remote_identity_lock.sql":"19725aee6086a1ec6cf66571c59a9259fd2687bed3677de8ea20be91fdd102b1","0137_top_artwork_publication.sql":"fb301e4509495fec7b738cc71a6c5f8961e3d27a9a9efdae29dfe3f4010dda9c","0138_artist_loved_playlists.sql":"e4bc755fc6b771c7739f1d57e21120b7464af717498286227299cd394982daf6","0139_listener_search_love_revision.sql":"336dfb30d55cde54021f430f8ca06159950dfb0bbfadaf1399b0c5b1c72a11ec","0140_create_relation_alias_endpoints.sql":"ab22828a5f84dcf824084a16694f59714d4716db535660b27005b44471881216","0141_album_favorites.sql":"717f6e7fdfa0d1ae4d0aad54e3e28623126ccfa58d0e009f165d803a03b6f4f5","0142_app_reported_playback_capture.sql":"385c251c668834300146f5310c2b05ba4eef1ea6a32520b2c9bcaf9cb52d1c2e","0143_playlist_album_top_previews.sql":"8ab44a603ae172685bb2401c21b4888b1b46b498c40a92f4b9cc68331b956c21","0144_top_native_catalog_binding_lock.sql":"eb1c76352dd35ca717834c1f4b06eaa61c930e2c437f6a76c96075b3ba4f20c4","0145_playlist_filter_preferences.sql":"aa8507c3286631735ce30565eab6d28f1206b5dbf2b5cf31dc8aebff7d3c1bd5","0146_album_top_source_jobs.sql":"3efd9e06e11fc32125a12b6529ea0c01bb3ca9e8fd80f7fb922b3b3cdbc598db","0147_album_top_source_finalization.sql":"2dabead4f6ed2e15fc2dff7f5a9e6571a10303b89115de80549af248983c3050","0148_album_top_url_acquisition.sql":"ca53fb94e622ab0395db9f5b33ed2264dd9b4abb98b43f390fdb942214a77de0","0149_album_top_local_artist_scope.sql":"50f598318824754603dfcbb338f1b744b714e853e022965456dc545f417c7f2e","0150_top_remote_credited_artist_evidence.sql":"400d0ee787134942d49ad4c8d556c8a816995a9d78e6f4509318f801370cf1e6","0151_sample_playlist_source_receipts.sql":"b3481917904db5eaa3559ef577d9eea97da6562614ddee53c210e2dedebdc93e","0152_sample_playlist_item_provenance.sql":"0d1af3fc0065b8b04e8fbe204b6a858c07e7e40f120777dc7ec9ac7e97e85bcc","0153_sample_playlist_typed_origins.sql":"7945ece2667a81c73de2d5f69c17aa645480bf5aaac2d757018831e37d9db845"},"168":{"0001_create_current_stack_schemas.sql":"af99fb5d41b9be2ff0bf45de2498f119a350bc2b0506318ed9b81b94706b910b","0002_create_local_mbid_assertions.sql":"208375e5e989b1aa7f002aecea08287472f57568568831903906eb9bffed9903","0003_add_local_mbid_projection_provenance.sql":"fcedd2adeed579e356edae4267eef1c88b1459baa1f29bcecbcee9c098c7755e","0004_add_lastfm_backfill_identities.sql":"8c86d3d439c6278692d6cae6f0a755568727f1dfe168686ddf791e5e79bc3ed8","0005_add_policy_context_hooks.sql":"1b174c1f1c3b0ca517fadb4592664c0c4625aa241689c8442362910ce9c39114","0006_scope_lastfm_sync_identities.sql":"b4c4a574cb1b5843b9099164961269223e844c2f3791e2afbc01ee0c9c9a472e","0007_scope_cover_lookup_task_identities.sql":"69584ccb7fe5850f0669dcdc6d191fab42904e98cc9c598459f71e7f060e87fc","0008_scope_saved_loop_identities.sql":"7c01ff55400c07e283628db91f94f0c68aac4ef07bd7850a1e98c98c7de86e3d","0009_create_user_discovery_preferences.sql":"50f405733b78aee5b63537e27c4b93b5c9557c243061030fd735f686fe67513f","0010_create_virtual_artist_snapshots.sql":"815c0ab009ce17f45bc41ff2a020036391406129450241d03be7fa86c9eaeee0","0011_create_log_history.sql":"834bfa7cfc219147652dc4f65dc326a88ab3f045ba65e80b1763cb79329c5215","0012_create_discovery_lookup_snapshots.sql":"26972a468722187dddb661c0aa8b95c6dcf0cf13640c52138c03299658f96435","0013_create_virtual_release_snapshots.sql":"ed7a7a15e4fc3f504870cfecd32e65e1694bb5677946d26e51fb8052c7571426","0014_update_bootstrap_owner_nominem.sql":"5f2fc3abfcaf763675e23436619988226c705d894be7ff28233e9ce3804026e1","0015_create_local_artist_family_links.sql":"643da57e5e8fd09a01580e4c032456af09a2b5813510e28dc7455763128c5777","0016_grant_local_artist_family_link_delete.sql":"9ca52401a68f02b93e00b51c8cea449e535e1fdc4111b549218f0fdf8c546b6b","0017_create_e2e_problematic_fixture_seeds.sql":"5f7764bf70a662da7967be3f02eb7c3870beb5e8ce4128315bd9e76826f1d96c","0018_repair_saved_loop_relations.sql":"232246fb993730d6ee32ee25daa5bf4267ffd960a4cb3c96058b040526ef7e37","0019_create_local_album_featured_artists.sql":"e8fce82f15dde806a635cb75959682824076de761ca9aef325a18ee31202ad51","0020_grant_runtime_delete_privileges.sql":"c0b09ea21d750c78e57b02692909f4bfbf144199799e7f02e4126e46b60a21c2","0021_add_problematic_file_generated_projection.sql":"2bb2cfccf2857668e12878cbd3d7ff2c9f9183128a0efcad001ea4a78ba94165","0022_fix_lastfm_pending_scrobble_conflict_identity.sql":"826db54bcd53c0d98bcf3b4bcf93e9324d3c942f6b616856541310daf49ead6d","0023_link_local_track_files_to_library_roots.sql":"f8a54b65a728e7baa4c751a4d7ca3a7a0d9b33ef0bc0d9b8ed03358259dcfe4f","0024_add_library_search_trigram_indexes.sql":"a1384a9b7f772523240a5d273c29f65f66a7c68033889471ab860b073a6dc94f","0025_grant_local_album_featured_artist_delete.sql":"4bf60d815f8bf190b6e38537c61b8c590839a60bb0b45b726cc9496cdf2d56b1","0026_create_album_ratings.sql":"ecffed81f62181097051b4750fffecf44b929ee871cd60d32035b198817f2279","0027_repair_cover_lookup_task_delete_grant.sql":"e6f714bffaa2a22dc4119cfff5b72435d8fbc4791e44599a06a452aeac8d8a7b","0028_repair_cover_lookup_task_conflict_identity.sql":"69584ccb7fe5850f0669dcdc6d191fab42904e98cc9c598459f71e7f060e87fc","0029_repair_lastfm_session_conflict_identity.sql":"7bb65105491a61ae3c16a568e008d0087b3888aa0a0a584fe7359ef20113b556","0030_drop_log_history.sql":"8f904e02775f36c1b4d8c685cbd46540046edc6593ea234202d58ca0d08d93b3","0031_add_problematic_active_track_index.sql":"d33841c3a6831d31e59edce881782c87bda966641847e5378698609deb53b564","0032_expand_problematic_active_track_index.sql":"1bbc0d9f1390459b383469ba7359c841e9c432c68f11b8bd6108d2c922f336a6","0033_repair_section14_album_identity_corruption.sql":"e4611cbdd0e728becf2cc249109d897934f24ddef4660337d25ae1b78e4483c7","0034_reconcile_semantic_local_albums.sql":"ac45c780cc0904f8ed9674bad80f7249dbcda9fe750698f76ab8e0afafcc2253","0035_enforce_semantic_local_album_identity.sql":"04a8b8e6223e87da079161af8e39d7e9eb1b3535e0b7b2d45f3d4b759318d588","0036_add_problematic_candidate_index.sql":"4c72e79b2b65ceda2f127cf05c7d30bc2d31ee8d762b75064650bc8b35a749db","0037_add_problematic_track_candidate_index.sql":"280c9787759d6596a597959e3ac868dad310287511d495f8c87963c2885c469d","0038_add_problematic_required_text_candidate.sql":"4e2fe1f16015cb8173029c0a670676d1470d3253d949a05d2b805b3af4719d1e","0039_repair_semantic_album_reconciliation_delete_grants.sql":"4725ee9b662c91b7dca3c82cfd4059fd5dfb822cfc8b7e8ce1e2db1606287f4b","0040_repair_ignored_repairs_delete_grant.sql":"b255a06f90fa0c4d91d4a5d98b4e77d62427fbedd039559388dda4cb454f255d","0041_create_local_album_cover_candidate_snapshots.sql":"83371681a280ed1644425b6766b8326bc730efebc653a37ca2a8e5c5bac76edd","0042_track_distinct_cover_improvement_alerts.sql":"cf9ead69b01515ceefabba345eb54eac75d34207b781122e34b43b3a5c438b6e","0043_create_local_track_waveform_peaks.sql":"6921c23429b7860640d4e68b0b7ebb3c1174d0c6cc23f55770dbd940f3e99dc1","0044_create_tag_edit_intents.sql":"1ba5105a870346687ecdfebd2f75fcad6b09e60fc784eee32c6ebf92c9946aec","0045_add_non_album_candidate_index.sql":"2ead0098e99335c0c15b0698b5f6039a356f8763f8ce26df03369e9103d4aa87","0046_add_local_auth_lifecycle.sql":"19a482f468566fd4f76b5625cfb5b1c373ff06f9c3aa5b447b5886662474c2ea","0047_add_auth_preauth_tokens.sql":"a18311d98e120a31db2e34da2d9a210c2bdeb41f979d1acb7a46684c638ec64e","0048_add_password_reset_transactions.sql":"84fd8348c1de715276ff047109c0650b67847e71d151fb5b61a808d64dd25df8","0049_enforce_single_use_password_reset_exchange.sql":"3644b833a3fd07dafcd1802673037de6db2a19c1f9a6fbc1dca0bded6dfe8b4d","0050_add_security_audit_cleanup_index.sql":"84f0d8591d59d7047dc65c1d24e34d5e74bef1847302e3b970e0c40e7224baaa","0051_add_auth_throttle_cleanup_index.sql":"a8fe9c9483040e445269e627f8ca25b0487435b7e45f2d88fd7fe9f88986e20a","0052_add_managed_account_invitations.sql":"527272f81f393be5c7fd32dd94031c13705912347ce476f45acb2cf3e2344c18","0053_create_user_appearance_preferences.sql":"31841a1f2413a3d2cc3cf5678b3ab23be1e12517d2487f2f5b7612b3738ce216","0054_add_appearance_palettes_and_player_colors.sql":"c875c2e1fea1f6228d0d0c3e843dba9cb18f49b56edaa2d8dbe65ca8b11b2167","0055_waveform_recent_colors.sql":"0f46853a5225cf8d338197ce645dd682fcee24eec2bc98b58030f583c2f92699","0056_compact_player_appearance_profiles.sql":"62082309e6ef9f53ffaa1c95fb18668d3a0399fc693430871dbf02bb67e30894","0057_aggregate_appearance_workspace.sql":"96da489ddf26a28e64a768fd74875b7b87c6fda0b215ccacb18e8edd67985620","0058_album_details_appearance.sql":"46cb63d33b77cee7672fd6a69c4a7dad6deca2a038b82ede14cd8f78979dca8f","0059_alert_appearance_family.sql":"a3f58a94a5fe96459264853e6adba03ea0dc4d97e01cfdb3f1e2c3daae8d6ab3","0060_player_aware_interaction_outline.sql":"01db8c6e5be72bd257dca4be188a09873fe93c651a47f528bf1e84e0ffee01c6","0061_create_missing_album_removal_function.sql":"3e32fceda6a21b2e0ed22fb1b2bb5076e0f1d22d435f3328b6f1f200c76315af","0062_narrow_readonly_account_privileges.sql":"70f3a4144c311825e1b8faba86215cfcffb50066bd0fa660bac1c04e91243584","0063_replace_missing_album_removal_lock_snapshot.sql":"95e706f18eca497273e65d2bfd3f7d11b8b2494340c8ff71f3c194641b0600da","0064_grant_library_membership_delete.sql":"3094a80b1c75578f632ee689681cf7949221a3780d9a7914ff6a23ea8a38964a","0065_native_player_component_provenance.sql":"ed39a4740063f715da2a4c1d40376250c0e1f0a0618d7da2efe01201308a31cf","0066_allow_appearance_panel_outline.sql":"3e1dd495f449a89da791f32c766703ba3b380d804431ea6a01bc378e14eb9744","0067_add_scanned_exception_candidate_index.sql":"7f91f559e34988f227a51b3cc3c15b0e1f128a4f7dd580277693c8f5ab46e342","0068_scoped_saved_loop_orders.sql":"0e621a844ccd081a809b3aa9b7a0d4ca96bed0ab68e5b1bc67900f7647fcda06","0069_scoped_operational_log_versions.sql":"800308a3200f11825becd4c9e4b373a469c27df1dbb63a201c8c5a4b3127d081","0070_appearance_loop_control_style.sql":"5e881cd776fbee018cc4ff3c61eae9b1fe95f6eb02a0c898007a5dd22ab2bf11","0071_allow_harbor_mint_appearance_palette.sql":"70fd5b42f5bc444f3f1a1493ffcd262cb9a138e0ffde4d897e036086354e8a04","0072_measured_local_listen_sessions.sql":"62bf0b7848facf2d70c72832c031af88066ca5c17607304ac2cf690f3c43bde4","0073_preserve_measured_listen_history.sql":"0789e51efc867b31693c343b86cfca8e9a037edd8c89c944b0df95e962250a67","0074_create_saved_loop_waveform_peaks.sql":"5ec365c4e993caf2d47b4e9e7cb42a4763231aa87d366c2ea811762a03c2b30d","0075_appearance_device_sections.sql":"4d34e1d97a6504bee08b82f9569cd448fa166fe2d4108e204b75462d8c029002","0076_docked_compact_player_behavior.sql":"05331b0ab76e629d810693423bd2d1a47a0ef97b5c5f3be51ed3e82aa134d5f1","0077_allow_parchment_pine_appearance_palette.sql":"0b05e82c6a0166e3231fcdd6057eed55a52b36df92de9cd8e80b450bd06ed4aa","0078_add_compact_player_motion_and_floating_edge.sql":"92ba922a46c39bd57a6ecca3099f05a1448ec08c70e6b4c785a5e4fc0067fd8d","0079_docked_compact_player_regular_style.sql":"621b473f3eb5738e3c463aafa34702c09a505746ee95b34072feadd425f96305","0080_user_client_layout_preferences.sql":"afa5cf574958b9bf04787c2e095d613e8168b6088096043e3435f75706fbfae4","0081_grant_move_policy_settings_delete.sql":"6736f051439f59e20431f7e772a1837e726d7f1822578740157aa92ed75591c0","0082_preserve_relations_for_missing_album_removal.sql":"4da41bd76f15b9d7c4e713ae696d4a89ae8fa044cda439ced9515fc0020853b3","0083_add_album_raw_artist_search_index.sql":"bdf32a924ab899e67da0fd4a927d23e26b936a79b22805a23c204dc816c3f810","0084_create_local_artist_search_projection.sql":"8b74086afda7b90bbfe6ca2e296c0b0cc9bc35e53e3d528d33c2a39d3d19c8b9","0085_add_stale_track_file_candidate_index.sql":"0c8c1fdd1dde3dbd0c0652931071ace0824397a7ecf73156ddd6d7ad7e14ad0f","0086_create_root_gallery_projection.sql":"653e18547d6d76d255e29af2f3a7dad65fd5b58d3e8f0da149c5ef5122119177","0087_reconcile_track_preferences_library_scope.sql":"36504b032406c6d2f471396ad0bf18470063a600a859608a6f8ca143ddb27888","0088_create_home_activity_snapshots.sql":"d4988f80c8fcfdf1711abc922660efd7d4ac298b7f9777702b275e39447df754","0089_create_owned_playlists.sql":"2ff9a5fbaaa9a3e745de3c1d28ee411e016118f7f0e90e4622ab68c875279010","0090_create_same_server_friends.sql":"18eb60d7f0d8201c52421fca8c4dd50b7a885a2f39c2940a0c7927745d5dbc6e","0091_playlist_collaboration.sql":"472dd6689b64db7d36e5139654a4898ec2d6d9d436f5622c57c81a2eb649b3b4","0092_playlist_settings.sql":"bb75619f91e99dfbc3567385dc256b1ad5617da50119b01193e47032faa7af46","0093_bind_home_activity_subjects.sql":"54c83be87a97ebe33858f4ad7ae5dbd21a63c4c854e4b6205420b229da3d9d91","0094_complete_playlist_selection_sources.sql":"1e4a7ecd20d1771a916534a5b3b48e83a85ab3a0c18aeb4c79f37be1af863cdf","0095_playlist_local_match_receipts.sql":"7056daedd0002a36d45218058de28f1bb632115acdbbe3935775776e044671fb","0096_create_current_playback_presence.sql":"6247efdb901fff233835c3edc8a0d0f996df90fb0473cab3200c8b8294277e0a","0100_playlist_viewer_actions.sql":"f7100d1ceb9df1ac7c550e28498fb63811523f1d6baf995e6b8e957ee5cfccc0","0101_create_album_top_artifacts.sql":"058b7e8a6f852fcafc9426216cc7513c3dd57ed74f65c037ac4df8c6e34325e3","0105_activity_missing_playlist_sources.sql":"4ed0363c23626f4ade36e9c9da3cfb0c487e64c0cb2ed940e0a9f2c8b79da57d","0106_playlist_copy_occurrences.sql":"6156d06f4c2552f81f91471087b6183fbc19c38672502831b6aad81ccc52e327","0107_allow_confirmed_catalog_album_versions.sql":"85f41ea9c9557d4d37cd804d0a995022bb5d7141d104819486f3e4c2e28e9a27","0108_album_top_collaboration.sql":"0a1aabe2d15386530f43d7967981e8a5fc69905cb6e51806e54ed29df1dc7820","0109_album_top_manual_progress.sql":"9e438752990b5365710a1ecd7e6f26f44a2a027200b147aed7eba3b5ab89ee42","0110_owner_save_top_publication.sql":"b616aa97c884f7a65915c3314df4eec07ead36fb9a82d7e99be42c13023fbd47","0111_owner_save_publication_seals.sql":"13ab0615f822efd24e0034513abd644cc854a2705b592fdf3745d9794f0d9680","0112_album_top_named_viewers.sql":"2bf1b800336b9573fa37e7e55dc47ea659bf5b80a3f8050850562cb40ab1829d","0113_popularity_source_observations.sql":"2b51da238430b2eac24be49f49a197ff671ce0970e70ffcecbd1e5536f238bbf","0114_intrinsic_personal_feature_access.sql":"fc22fd0b9f8d31dea72e502372e8c6b77ad78c3455025619e7804c4e710c690b","0115_playlist_library_mixes.sql":"691f238c5319e453c71f42ea478d8a932d3e497d8743d61c09cd15e0a1a3f91a","0116_local_track_popularity_mappings.sql":"e473c5c2ffd6c9f41c2c91e0f6d7596e3edcc901fdc29886fbad3cc395de52f4","0117_album_top_activity.sql":"7936ca297d73ec427e3572aa45626e770721bdfdfeacf7dc516700469e086692","0118_listening_goals.sql":"4f63b2cbfcfb4107deb931f3656b9e4da65fd99115f5a146110e125d382c9b18","0119_artist_popular_mix_scope.sql":"a561ac026c1005275beab9a5aa6db60629a46c9ea5380211e1dedcbc37b67cb9","0120_listening_goal_manual_membership.sql":"94a5c62074281f6a555c2ae24302784baf29170d2f4074001341427995383284","0121_listening_goal_bonus_settings.sql":"a4a2a23185ca7427bef7569461a66a036d8eba5073b7c3c2e932707053810e38","0122_listening_goal_bonus_draw.sql":"b8eb10905d09c43a493f4a252a7ee617df2bb9b64081b66b45e13e1f81bcb291","0123_listening_goal_period_transition.sql":"f5c497fd44bd3e8ee3a13f5242eab6939e6df51c5f5930143bc86d5484e1c71e","0124_listening_goal_attention.sql":"e826b52e390db3f6f2dfa3b971f511b2364a8411f4a30e29720204903af465db","0125_measured_listen_admission.sql":"e55645c8811684677dc8c072c74f50679d1c28441956f96c2a9e0247630f79e6","0126_private_top_artwork_preparation.sql":"d4fd8b5272296d02551b529b3eb6d1d9adb0a811b2aa1e4e4f4f949850bbc7e4","0127_private_top_remote_acquisition.sql":"b849fdb42550fe549561c9199eb87a3af3622003edb187ec08128e28ada99d65","0128_private_top_remote_membership.sql":"4b1147d3cc9e6d5071cb2867e496376361506c1ebba9143e36534dc84a34f639","0129_top_artwork_retention.sql":"d2c009885015b8503a192c9b1c9798c07b7e7aabdedb46ea3c9715285128fecd","0130_private_top_artwork_drafts.sql":"271d5b0926f24670d93a770bd66d33bea0d3a2cb97f11b3aa634d547f856c4d2","0131_top_artwork_completion_alias.sql":"da590b61b53beb58d6d920d939ad12d0d2fa2fbc54686776c680b4f5ed684e5d","0132_private_top_remote_preparations.sql":"437d7cf3722e313b112106c0919d6a28403e2fa769daab9f735b6c59435ffdfb","0133_private_top_remote_consumption.sql":"c433536b1600e706dd61fcda3fec9b8936cdccd9f1cb1b23acddac410c8d76bc","0134_private_top_artwork_draft_capture.sql":"a2226a26b9732d70a17af35d0054fba05e0306156dbed94d2c02e2b4c8c6c87e","0135_public_metadata_file_invalidation.sql":"818a4734aa6717efd0ff1aae96e583b6b2f00a52424fcde94f8af38f0014adc5","0136_private_top_remote_identity_lock.sql":"19725aee6086a1ec6cf66571c59a9259fd2687bed3677de8ea20be91fdd102b1","0137_top_artwork_publication.sql":"fb301e4509495fec7b738cc71a6c5f8961e3d27a9a9efdae29dfe3f4010dda9c","0138_artist_loved_playlists.sql":"e4bc755fc6b771c7739f1d57e21120b7464af717498286227299cd394982daf6","0139_listener_search_love_revision.sql":"336dfb30d55cde54021f430f8ca06159950dfb0bbfadaf1399b0c5b1c72a11ec","0140_create_relation_alias_endpoints.sql":"ab22828a5f84dcf824084a16694f59714d4716db535660b27005b44471881216","0141_album_favorites.sql":"717f6e7fdfa0d1ae4d0aad54e3e28623126ccfa58d0e009f165d803a03b6f4f5","0142_app_reported_playback_capture.sql":"385c251c668834300146f5310c2b05ba4eef1ea6a32520b2c9bcaf9cb52d1c2e","0143_playlist_album_top_previews.sql":"8ab44a603ae172685bb2401c21b4888b1b46b498c40a92f4b9cc68331b956c21","0144_top_native_catalog_binding_lock.sql":"eb1c76352dd35ca717834c1f4b06eaa61c930e2c437f6a76c96075b3ba4f20c4","0145_playlist_filter_preferences.sql":"aa8507c3286631735ce30565eab6d28f1206b5dbf2b5cf31dc8aebff7d3c1bd5","0146_album_top_source_jobs.sql":"3efd9e06e11fc32125a12b6529ea0c01bb3ca9e8fd80f7fb922b3b3cdbc598db","0147_album_top_source_finalization.sql":"2dabead4f6ed2e15fc2dff7f5a9e6571a10303b89115de80549af248983c3050","0148_album_top_url_acquisition.sql":"ca53fb94e622ab0395db9f5b33ed2264dd9b4abb98b43f390fdb942214a77de0","0149_album_top_local_artist_scope.sql":"50f598318824754603dfcbb338f1b744b714e853e022965456dc545f417c7f2e","0150_top_remote_credited_artist_evidence.sql":"400d0ee787134942d49ad4c8d556c8a816995a9d78e6f4509318f801370cf1e6","0151_sample_playlist_source_receipts.sql":"b3481917904db5eaa3559ef577d9eea97da6562614ddee53c210e2dedebdc93e","0152_sample_playlist_item_provenance.sql":"0d1af3fc0065b8b04e8fbe204b6a858c07e7e40f120777dc7ec9ac7e97e85bcc","0153_sample_playlist_typed_origins.sql":"7945ece2667a81c73de2d5f69c17aa645480bf5aaac2d757018831e37d9db845","0154_library_source_indicators.sql":"e1a292e50a08e4043d2ce3ceda13b87ad90462deb898590c147bab492a01b5e1","0155_add_active_physical_parent_index.sql":"29c3e9344d72cea1faff37b86dcd0b5b8904ba558a52c7b795dcd30253832e37","0156_allow_gallery_projection_featured_kind.sql":"8ce9516a9c1955df496036a652afeadd5b089b86afdc7a0bedb2709150365c94","0157_patch_local_artist_search_projection.sql":"22a58535ec35a913c2165db63f619b6505864caf33a627ddbfda1a33b5b4cb37","0158_add_gallery_projection_artist_lookup_indexes.sql":"91dd382d8fd107fed5b763f624f525baf4bf31937b584d1b353d36629590ac66","0159_add_locale_independent_search_prefilter.sql":"8bae9da748f351adc9df68670b47760ff2665c092f7709a108e4e1fd6604bf88","0160_add_duplicate_identity_lookup_index.sql":"bde16a720d6af16ed50461e73543d0af6565fac27b42176bd767fe6a764034fa","0161_stage_gallery_projection_publication.sql":"48c42c5d8a88252a5c43d6eaa04f7692c38f4a8b97029d3da7aaf8e1fa408a20","0162_add_root_preview_artist_order_index.sql":"0239b964d344b73f93f7e07eff3af901174884e71d6a4bb47a41905a5699cacf","0163_create_generated_preview_storage.sql":"7dcb41ea9dc77cd5dc612b0eff5dcad4361c36c1d9a6176fd0477de061fde9df","0164_repair_generated_preview_inventory_path_constraint.sql":"2f77683107a5126e6cfe4936293679c104e8f04ffaf3a0ef040c50deada7dce7","0165_track_generated_preview_current_path.sql":"847b56cd2d8bbfb23a6548ae29a53b48d3d9e686aa8a1bd24a63f168c0e9cd81","0166_listening_goal_weekly_settings.sql":"004b72e33d9ab05e6cf1d57502434678b833b88578ab3473f69c187133aaf80a","0167_recommendation_collections.sql":"6512bf9b55a93241bffdbf4a7c296d751a02b92e926c779ff32bf8a890fc268f","0168_align_relation_alias_projection_versions.sql":"ba76939b3eb8dbe7d1181237380cea263daacd8089d9d955b5281b974e345899"}}$inventory_contract$::jsonb;
  table_names constant text[] := array(select jsonb_array_elements_text($tables$["integration.playback_capture_budget","integration.playback_capture_session","integration.playback_capture_checkpoint","integration.playback_capture_anchor","integration.playback_capture_run","integration.playback_capture_owner","integration.playback_capture_loss","integration.playback_capture_history_revision","integration.playback_edition_selection","integration.playback_edition_capture","integration.playback_decoder_observation","integration.playback_album_metrics_state","app.album_top_listening_settings","app.album_ratings","app.album_list_items","app.album_list_item_progress"]$tables$::jsonb));
  base_columns constant jsonb := $base_columns${"app.album_ratings":["native_rating_intent_at"],"app.album_list_items":["listening_baseline_at"],"app.album_list_item_progress":["listening_item_ref","listening_baseline_at"]}$base_columns$::jsonb;
  actual jsonb; rows jsonb; row_value jsonb; expected_rows jsonb; category_rows jsonb;
  acl_rows jsonb; acl_entry jsonb; ledger jsonb;
  statement text; category text; relation_name text; key_name text; stage text; role_profile text;
  required_columns text[]; trigger_functions text[];
  phase integer;
begin
  if current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'Incompatible listening tracking PostgreSQL major version';
  end if;
  if session_user<>current_user then
    raise exception 'Incompatible listening tracking installer session';
  end if;
  if (select count(*) from pg_roles where rolname in
      ('album_haven_migrator','album_haven_app','album_haven_readonly'))<>3 then
    raise exception 'Incompatible listening tracking role prerequisites';
  end if;
  role_profile:=case when current_user='album_haven_migrator' then 'direct' else 'separate-owner' end;
  if to_regclass('ops.schema_migrations') is null then
    raise exception 'Incompatible listening tracking migration ledger: missing';
  end if;
  select coalesce(jsonb_object_agg(migration_name,checksum),'{}'::jsonb)
    into ledger from ops.schema_migrations;
  if ledger is distinct from inventories->'153' and ledger is distinct from inventories->'168' then
    raise exception 'Incompatible listening tracking migration ledger';
  end if;

  -- Locks protect existing feature relations while comparing and changing them.
  -- Unknown/partial shapes are diagnosed before any DDL is executed.
  foreach relation_name in array table_names loop
    if to_regclass(relation_name) is not null then
      if not exists(select 1 from pg_class where oid=to_regclass(relation_name) and relkind='r') then
        raise exception 'Incompatible listening tracking relation kind: %',relation_name;
      end if;
      execute format('lock table %s in access exclusive mode',to_regclass(relation_name));
    end if;
  end loop;

  for phase in 0..1 loop
    actual := '{}'::jsonb;
    trigger_functions := array[]::text[];
    for category, statement in select name,query from (values
      (0, 'relations', $query$select c.oid::regclass::text as relation, c.relkind, c.relpersistence,
        pg_get_userbyid(c.relowner) as owner, c.relrowsecurity,
        c.relforcerowsecurity, c.relispartition, c.reloptions,
        (select jsonb_agg(i.inhparent::regclass::text order by i.inhseqno)
           from pg_inherits i where i.inhrelid=c.oid) as parents,
        (select jsonb_agg(i.inhrelid::regclass::text order by i.inhrelid::regclass::text)
           from pg_inherits i where i.inhparent=c.oid) as children,
        (select jsonb_agg(pg_get_ruledef(r.oid) order by r.rulename)
           from pg_rewrite r where r.ev_class=c.oid) as rules
      from pg_class c where c.oid=any(select to_regclass(x) from unnest($1::text[]) x)
      order by relation$query$),
      (1, 'columns', $query$select a.attrelid::regclass::text as relation, a.attname, a.attnum,
        format_type(a.atttypid,a.atttypmod) as type, a.atttypmod,
        a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl is null as default_acl,
        case when a.attcollation=0 then null else a.attcollation::regcollation::text end as collation,
        pg_get_expr(d.adbin,d.adrelid) as default_expression
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=any(select to_regclass(x) from unnest($1::text[]) x) and a.attnum>0
      order by relation,a.attnum$query$),
      (2, 'constraints', $query$select k.conrelid::regclass::text as relation,k.conname,k.contype,
        pg_get_constraintdef(k.oid,false) as definition,k.convalidated,
        k.condeferrable,k.condeferred,k.connoinherit,
        array(select a.attname from unnest(k.conkey) with ordinality u(num,pos)
              join pg_attribute a on a.attrelid=k.conrelid and a.attnum=u.num order by u.pos) as columns,
        case when k.confrelid=0 then null else k.confrelid::regclass::text end as foreign_relation,
        k.confupdtype,k.confdeltype,k.confmatchtype,
        (select jsonb_agg(jsonb_build_object(
          'relation',t.tgrelid::regclass::text,'function',t.tgfoid::regprocedure::text,
          'type',t.tgtype,'enabled',t.tgenabled,'deferrable',t.tgdeferrable,
          'deferred',t.tginitdeferred,'args',encode(t.tgargs,'hex'),
          'when',pg_get_expr(t.tgqual,t.tgrelid),'internal',t.tgisinternal)
          order by t.tgrelid::regclass::text,t.tgfoid::regprocedure::text,t.tgtype)
         from pg_trigger t where t.tgconstraint=k.oid) as constraint_triggers
      from pg_constraint k
      where k.conrelid=any(select to_regclass(x) from unnest($1::text[]) x)
      order by relation,k.conname$query$),
      (3, 'indexes', $query$select i.indrelid::regclass::text as relation,c.relname,
        pg_get_indexdef(i.indexrelid,0,false) as definition,
        i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary,
        i.indisexclusion,i.indnullsnotdistinct,i.indimmediate,
        c.relkind,c.relpersistence,c.reloptions,pg_get_userbyid(c.relowner) as owner,
        array(select a.attname from unnest(i.indkey::smallint[]) with ordinality u(num,pos)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=u.num order by u.pos) as columns,
        array(select distinct a.attname from pg_depend d
          join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
          where d.classid='pg_class'::regclass and d.objid=i.indexrelid
            and d.refclassid='pg_class'::regclass and d.refobjid=i.indrelid
            and d.refobjsubid>0 order by a.attname) as dependent_columns
      from pg_index i join pg_class c on c.oid=i.indexrelid
      where i.indrelid=any(select to_regclass(x) from unnest($1::text[]) x)
      order by relation,c.relname$query$),
      (4, 'triggers', $query$select t.tgrelid::regclass::text as relation,t.tgname,
        pg_get_triggerdef(t.oid,false) as definition,t.tgenabled,t.tgtype,
        t.tgfoid::regprocedure::text as function,t.tgdeferrable,t.tginitdeferred,
        encode(t.tgargs,'hex') as args,pg_get_expr(t.tgqual,t.tgrelid) as condition,
        array(select a.attname from unnest(t.tgattr::smallint[]) u(num)
          join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=u.num order by a.attnum) as columns
      from pg_trigger t
      where t.tgrelid=any(select to_regclass(x) from unnest($1::text[]) x) and not t.tgisinternal
      order by relation,t.tgname$query$),
      (5, 'policies', $query$select p.polrelid::regclass::text as relation,p.polname,p.polcmd,p.polpermissive,
        array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end
              from unnest(p.polroles) r order by 1) as roles,
        pg_get_expr(p.polqual,p.polrelid) as using_expression,
        pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
      from pg_policy p where p.polrelid=any(select to_regclass(x) from unnest($1::text[]) x)
      order by relation,p.polname$query$),
      (6, 'table_acl', $query$select c.oid::regclass::text as relation,c.relacl is null as default_acl,
        case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
        pg_get_userbyid(x.grantor) as grantor,x.privilege_type,x.is_grantable
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
      where c.oid=any(select to_regclass(v) from unnest($1::text[]) v)
      order by relation,grantee,grantor,x.privilege_type$query$),
      (7, 'column_acl', $query$select a.attrelid::regclass::text as relation,a.attname,
        case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
        pg_get_userbyid(x.grantor) as grantor,x.privilege_type,x.is_grantable
      from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid=any(select to_regclass(v) from unnest($1::text[]) v) and a.attnum>0
      order by relation,a.attname,grantee,grantor,x.privilege_type$query$),
      (8, 'functions', $query$select p.oid::regprocedure::text as identity,n.nspname,p.proname,
    pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_function_arguments(p.oid) as declared_arguments,p.pronargdefaults,
    pg_get_function_result(p.oid) as result,l.lanname,p.prokind,p.prosrc,
    p.prosecdef,p.proleakproof,p.proisstrict,p.provolatile,p.proparallel,
    p.proconfig,p.procost,p.prorows,pg_get_userbyid(p.proowner) as owner,
    p.proacl is null as default_acl,
    (select jsonb_agg(jsonb_build_object(
       'grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
       'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
       order by x.grantee,x.grantor,x.privilege_type)
     from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) as acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    join pg_language l on l.oid=p.prolang
  where (n.nspname='integration' and starts_with(p.proname,'playback_'))
    or (n.nspname='app' and p.proname='guard_album_top_listening_settings')
    or p.oid::regprocedure::text=any($2::text[])
  order by identity$query$),
      (9, 'sequences', $query$select c.oid::regclass::text as relation,pg_get_userbyid(c.relowner) as owner,
    format_type(s.seqtypid,null) as type,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,
    c.relacl is null as default_acl,
    (select jsonb_agg(jsonb_build_object(
       'grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
       'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
       order by x.grantee,x.grantor,x.privilege_type)
     from aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) x) as acl,
    (select jsonb_agg(jsonb_build_object('relation',d.refobjid::regclass::text,
       'column',a.attname,'kind',d.deptype) order by d.refobjid::regclass::text,a.attname,d.deptype)
     from pg_depend d join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
     where d.classid='pg_class'::regclass and d.objid=c.oid
       and d.refclassid='pg_class'::regclass and d.refobjsubid>0) as owned_columns
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_sequence s on s.seqrelid=c.oid
  where n.nspname='integration' and starts_with(c.relname,'playback_') order by relation$query$),
      (10, 'creator_defaults', $query$select case when a.defaclnamespace=0 then '*' else n.nspname end as schema,
    a.defaclobjtype as kind,pg_get_userbyid(a.defaclrole) as owner,
    case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
    pg_get_userbyid(x.grantor) as grantor,x.privilege_type,x.is_grantable
  from pg_default_acl a left join pg_namespace n on n.oid=a.defaclnamespace
    left join lateral aclexplode(a.defaclacl) x on true
  where a.defaclrole=(select oid from pg_roles where rolname=current_user)
    and (a.defaclnamespace=0 or n.nspname in ('integration','app'))
    and a.defaclobjtype in ('r','S','f')
  order by schema,kind,grantee,grantor,x.privilege_type$query$),
      (11, 'effective_table', $query$select c.oid::regclass::text as relation,r.rolname as role,
    v.privilege,has_table_privilege(r.oid,c.oid,v.privilege) as allowed
  from pg_class c cross join pg_roles r
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
      ('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(privilege)
  where c.oid=any(select to_regclass(x) from unnest($1::text[]) x)
    and r.rolname in ('album_haven_app','album_haven_readonly','album_haven_migrator')
  order by relation,r.rolname,v.privilege$query$),
      (12, 'effective_schema', $query$select n.nspname as schema,r.rolname as role,
    has_schema_privilege(r.oid,n.oid,'USAGE') as usage,
    has_schema_privilege(r.oid,n.oid,'CREATE') as create_allowed,
    case when r.rolname='album_haven_migrator' then null else
      pg_has_role(r.oid,(select oid from pg_roles where rolname=current_user),'MEMBER') end as migration_membership,
    case when r.rolname='album_haven_migrator' then null else
      pg_has_role(r.oid,'album_haven_migrator','MEMBER') end as named_migrator_membership
  from pg_namespace n cross join pg_roles r
  where n.nspname in ('app','integration')
    and r.rolname in ('album_haven_app','album_haven_readonly','album_haven_migrator')
  order by n.nspname,r.rolname$query$),
      (13, 'effective_column', $query$select a.attrelid::regclass::text as relation,a.attname,r.rolname as role,
    v.privilege,has_column_privilege(r.oid,a.attrelid,a.attnum,v.privilege) as allowed
  from pg_attribute a cross join pg_roles r
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege)
  where a.attrelid=any(select to_regclass(x) from unnest($1::text[]) x)
    and a.attnum>0 and not a.attisdropped
    and r.rolname in ('album_haven_app','album_haven_readonly','album_haven_migrator')
  order by relation,a.attnum,r.rolname,v.privilege$query$),
      (14, 'effective_sequence', $query$select c.oid::regclass::text as relation,r.rolname as role,v.privilege,
    has_sequence_privilege(r.oid,c.oid,v.privilege) as allowed
  from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
    cross join (values ('USAGE'),('SELECT'),('UPDATE')) v(privilege)
  where n.nspname='integration' and c.relkind='S' and starts_with(c.relname,'playback_')
    and r.rolname in ('album_haven_app','album_haven_readonly','album_haven_migrator')
  order by relation,r.rolname,v.privilege$query$),
      (15, 'effective_function', $query$select p.oid::regprocedure::text as identity,r.rolname as role,
    has_function_privilege(r.oid,p.oid,'EXECUTE') as allowed
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
  where ((n.nspname='integration' and starts_with(p.proname,'playback_'))
    or (n.nspname='app' and p.proname='guard_album_top_listening_settings')
    or p.oid::regprocedure::text=any($2::text[]))
    and r.rolname in ('album_haven_app','album_haven_readonly','album_haven_migrator')
  order by identity,r.rolname$query$),
      (16, 'feature_identities', $query$select n.nspname as schema,c.relname,c.relkind
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='integration' and
    (starts_with(c.relname,'playback_capture_') or starts_with(c.relname,'playback_edition_')
     or starts_with(c.relname,'playback_decoder_observation') or starts_with(c.relname,'playback_album_metrics_state')))
    or (n.nspname='app' and starts_with(c.relname,'album_top_listening_settings'))
  order by n.nspname,c.relname$query$),
      (17, 'installer', $query$select case when current_user='album_haven_migrator' then 'direct' else 'separate-owner' end as topology,
    current_user as owner,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    pg_has_role(current_user,'album_haven_migrator','MEMBER') as named_migrator_membership,
    session_user=current_user as same_session,
    login_role.rolsuper as session_superuser,login_role.rolcreatedb as session_createdb,
    login_role.rolcreaterole as session_createrole,login_role.rolreplication as session_replication,
    login_role.rolbypassrls as session_bypassrls
  from pg_roles r cross join pg_roles login_role
  where r.rolname=current_user and login_role.rolname=session_user$query$)
    ) as capture(position,name,query) order by position loop
      execute 'select coalesce(jsonb_agg(to_jsonb(fact)),''[]''::jsonb) from (' || statement || ') fact'
        into rows using table_names,trigger_functions;
      category_rows := '[]'::jsonb;
      for row_value in select value from jsonb_array_elements(rows) loop
        relation_name := row_value->>'relation';
        if base_columns ? relation_name then
          required_columns := array(select jsonb_array_elements_text(base_columns->relation_name));
          if category in ('columns','column_acl','effective_column') then
            if not (row_value->>'attname'=any(required_columns)) then continue; end if;
            if category='columns' then row_value:=row_value||'{"attnum":null}'::jsonb; end if;
          elsif category='relations' then
            row_value:=row_value-'reloptions';
          elsif category in ('constraints','indexes') then
            if not ((coalesce(row_value->'columns','[]'::jsonb)
              ||coalesce(row_value->'dependent_columns','[]'::jsonb)) ?| required_columns)
            then continue; end if;
          elsif category='triggers' then
            if jsonb_array_length(row_value->'columns')>0
              and not ((row_value->'columns') ?| required_columns) then continue; end if;
          elsif category='effective_table' then
            if row_value->>'privilege' not in ('SELECT','INSERT','UPDATE','REFERENCES') then continue; end if;
          end if;
        end if;
        foreach key_name in array array['owner','grantor','grantee'] loop
          if row_value->>key_name=current_user then
            row_value:=jsonb_set(row_value,array[key_name],to_jsonb('$migration_owner'::text));
          end if;
        end loop;
        if row_value ? 'acl' and row_value->'acl'<>'null'::jsonb then
          acl_rows:='[]'::jsonb;
          for acl_entry in select value from jsonb_array_elements(row_value->'acl') loop
            foreach key_name in array array['owner','grantor','grantee'] loop
              if acl_entry->>key_name=current_user then
                acl_entry:=jsonb_set(acl_entry,array[key_name],to_jsonb('$migration_owner'::text));
              end if;
            end loop;
            acl_rows:=acl_rows||jsonb_build_array(acl_entry);
          end loop;
          select coalesce(jsonb_agg(value order by value->>'grantee',value->>'grantor',value->>'privilege'),'[]'::jsonb)
            into acl_rows from jsonb_array_elements(acl_rows);
          row_value:=jsonb_set(row_value,array['acl'],acl_rows);
        end if;
        category_rows:=category_rows||jsonb_build_array(row_value);
      end loop;
      actual:=jsonb_set(actual,array[category],category_rows);
      if category='triggers' then
        select coalesce(array_agg(distinct value->>'function' order by value->>'function'),array[]::text[])
          into trigger_functions from jsonb_array_elements(actual->category);
      elsif category='effective_column' then
        select coalesce(jsonb_agg(jsonb_build_object('relation',grouped.relation,
          'role',grouped.role,'privilege',grouped.privilege,'allowed_columns',grouped.allowed_columns)),
          '[]'::jsonb) into rows from (
          select value->>'relation' as relation,value->>'role' as role,value->>'privilege' as privilege,
            coalesce(jsonb_agg(value->>'attname' order by value->>'attname')
              filter(where (value->>'allowed')::boolean),'[]'::jsonb) as allowed_columns
          from jsonb_array_elements(actual->category)
          group by value->>'relation',value->>'role',value->>'privilege'
        ) grouped;
        actual:=jsonb_set(actual,array[category],rows);
      end if;
    end loop;

    if phase=1 then
      stage:='CF';
    elsif to_regclass('integration.playback_capture_owner') is null then
      stage:='C0';
    elsif exists(select 1 from jsonb_array_elements(actual->'constraints') c
        where c->>'relation'='integration.playback_decoder_observation'
          and c->>'conname'='playback_decoder_observation_flac441_swr48_v1') then
      stage:='CF';
    elsif exists(select 1 from jsonb_array_elements(actual->'constraints') c
        where c->>'relation'='integration.playback_decoder_observation'
          and c->>'conname'='playback_decoder_observation_absolute_flac48_v1') then
      stage:='CA';
    else
      stage:='C9';
    end if;

    for category in select jsonb_object_keys(contract) loop
      select coalesce(jsonb_agg(expanded.fact),'[]'::jsonb) into expected_rows
        from jsonb_array_elements(contract->category->'states'->(role_profile||':'||stage)) chosen
        cross join lateral (select contract->category->'rows'->(chosen.value::text::integer) as entry) stored
        cross join lateral (
          select jsonb_object_agg(fields.name,stored.entry->1->(fields.position::integer-1)) as fact
          from jsonb_array_elements_text(contract->category->'fields'->(stored.entry->>0)::integer)
            with ordinality as fields(name,position)
        ) expanded;
      -- Row multisets ignore harmless ordering but reject duplicates/missing facts.
      if exists(select 1 from (
        (select value from jsonb_array_elements(actual->category)
          except all select value from jsonb_array_elements(expected_rows))
        union all
        (select value from jsonb_array_elements(expected_rows)
          except all select value from jsonb_array_elements(actual->category))
      ) mismatch) then
        raise exception 'Incompatible listening tracking catalog: % (%, phase %)',category,stage,phase;
      end if;
    end loop;

    if phase=0 then
      if stage='C0' then
        execute $install_graph$
create table integration.playback_capture_owner (
  id bigint generated always as identity primary key
    check (id between 1 and 9007199254740991),
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  device_uuid uuid not null,
  auth_session_guard text not null check (octet_length(auth_session_guard) between 1 and 256),
  owner_uuid uuid not null check (owner_uuid <> '00000000-0000-0000-0000-000000000000'::uuid),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  reservation_bytes bigint not null check (reservation_bytes=1024),
  unique(account_id,library_id,device_uuid,auth_session_guard,owner_uuid)
);

alter table integration.playback_capture_session
  drop constraint playback_capture_session_evidence_version_check,
  drop constraint playback_capture_session_reservation_bytes_check,
  add column owner_id bigint references integration.playback_capture_owner(id) on delete set null,
  add column owner_uuid uuid,
  add constraint playback_capture_session_version_check
    check (evidence_version in ('app-rendered-position-v1','app-rendered-position-v2')),
  add constraint playback_capture_session_charge_check
    check ((evidence_version='app-rendered-position-v1' and reservation_bytes=256)
        or (evidence_version='app-rendered-position-v2' and reservation_bytes=384));
create index playback_capture_session_owner_ref
  on integration.playback_capture_session(owner_id) where owner_id is not null;

alter table integration.playback_capture_checkpoint
  alter column digest drop not null,
  add column evidence_redacted boolean not null default false,
  add constraint playback_capture_checkpoint_redaction_check
    check ((not evidence_redacted and digest is not null)
        or (evidence_redacted and digest is null
            and not (evidence ? 'owner_uuid') and not (receipt_body ? 'digest')));

alter table integration.playback_capture_run
  drop constraint playback_capture_run_reservation_bytes_check,
  add column owner_id bigint references integration.playback_capture_owner(id) on delete set null,
  add column binding_serial bigint check (binding_serial between 1 and 9007199254740991),
  add column generation bigint check (generation between 1 and 9007199254740991),
  add column stream_id bigint check (stream_id between 1 and 9007199254740991),
  add column source_base48 bigint check (source_base48 between 0 and 9007199254740991),
  add column continuity_serial bigint check (continuity_serial between 1 and 9007199254740991),
  add constraint playback_capture_run_charge_check check (reservation_bytes in (128,320));
create unique index playback_capture_run_owner_ordinal
  on integration.playback_capture_run(owner_id,ordinal_start) where owner_id is not null;
create index playback_capture_run_owner_binding
  on integration.playback_capture_run(owner_id,binding_serial) where owner_id is not null;

create table integration.playback_capture_loss (
  id bigint generated always as identity primary key,
  checkpoint_id bigint not null references integration.playback_capture_checkpoint(id) on delete cascade,
  gap_index integer not null check (gap_index between 0 and 7),
  owner_id bigint references integration.playback_capture_owner(id) on delete set null,
  ordinal_start bigint not null check (ordinal_start between 0 and 9007199254740991),
  ordinal_end bigint not null check (ordinal_end between 1 and 9007199254740991),
  output_start bigint not null check (output_start between 0 and 9007199254740991),
  output_end bigint not null check (output_end between 1 and 9007199254740991),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  reservation_bytes bigint not null check (reservation_bytes=384),
  check (ordinal_end>ordinal_start and output_end>output_start),
  unique(checkpoint_id,gap_index)
);
create index playback_capture_loss_owner_ref
  on integration.playback_capture_loss(owner_id) where owner_id is not null;
create index playback_capture_loss_budget_ref
  on integration.playback_capture_loss(account_budget_id) where account_budget_id is not null;
create index playback_capture_loss_owner_ordinal_range
  on integration.playback_capture_loss using gist
  (int8range(owner_id,owner_id,'[]'),int8range(ordinal_start,ordinal_end,'[)'))
  where owner_id is not null;
create index playback_capture_loss_owner_output_range
  on integration.playback_capture_loss using gist
  (int8range(owner_id,owner_id,'[]'),int8range(output_start,output_end,'[)'))
  where owner_id is not null;

create function integration.playback_capture_v2_guard_owner() returns trigger
language plpgsql volatile security invoker as $$
begin
  if row(new.id,new.account_id,new.library_id,new.device_uuid,new.auth_session_guard,
         new.owner_uuid,new.reservation_bytes)
     is distinct from row(old.id,old.account_id,old.library_id,old.device_uuid,
                          old.auth_session_guard,old.owner_uuid,old.reservation_bytes)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture owner is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger playback_capture_owner_immutable before update
  on integration.playback_capture_owner for each row
  execute function integration.playback_capture_v2_guard_owner();

create function integration.playback_capture_v2_guard_session() returns trigger
language plpgsql volatile security invoker as $$
begin
  if tg_op='UPDATE' and new.evidence_version is distinct from old.evidence_version then
    raise exception 'capture version is immutable' using errcode='23514';
  end if;
  if new.evidence_version<>'app-rendered-position-v2' then return new; end if;
  if tg_op='INSERT' then
    if new.account_id is null or new.owner_id is null or new.owner_uuid is null then
      raise exception 'capture requires initial owned state' using errcode='23514';
    end if;
    return new;
  end if;
  if new.account_id is distinct from old.account_id then
    if new.account_id is not null or old.account_id is null
       or exists(select 1 from app.accounts where id=old.account_id) then
      raise exception 'direct capture anonymization is unsupported' using errcode='23514';
    end if;
    -- Genuine account DELETE only. Redaction is performed by the existing
    -- anonymize trigger below; allow its cleared identity in either name order.
    return new;
  end if;
  if row(new.id,new.library_id,new.auth_session_guard,new.device_uuid,new.capture_uuid,
         new.v1_session_uuid,new.owner_uuid,new.original_track_id,new.original_file_id,
         new.original_root_id,new.original_album_id,new.disc_number,new.track_number,
         new.admitted_at,new.reservation_bytes)
     is distinct from row(old.id,old.library_id,old.auth_session_guard,old.device_uuid,
         old.capture_uuid,old.v1_session_uuid,old.owner_uuid,old.original_track_id,
         old.original_file_id,old.original_root_id,old.original_album_id,
         old.disc_number,old.track_number,old.admitted_at,old.reservation_bytes)
     or (new.owner_id is distinct from old.owner_id and new.owner_id is not null)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture binding is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger playback_capture_v2_session_guard before insert or update
  on integration.playback_capture_session for each row
  execute function integration.playback_capture_v2_guard_session();

create or replace function integration.playback_capture_anonymize() returns trigger
language plpgsql volatile security invoker as $$
begin
  if new.account_id is null then
    if new.evidence_version='app-rendered-position-v2' then
      if old.account_id is not null
         and exists(select 1 from app.accounts where id=old.account_id) then
        raise exception 'direct capture anonymization is unsupported' using errcode='23514';
      end if;
      new.owner_id := null;
      new.owner_uuid := null;
      update integration.playback_capture_checkpoint
         set evidence=evidence-'owner_uuid', digest=null,
             receipt_body=receipt_body-'digest', evidence_redacted=true
       where session_id=old.id and not evidence_redacted;
    end if;
    -- Exact v1 identity-clearing behavior is preserved.
    new.auth_session_guard := null;
    new.device_uuid := null;
    new.capture_uuid := null;
    new.v1_session_uuid := null;
    new.account_budget_id := null;
  end if;
  return new;
end;
$$;

create function integration.playback_capture_v2_guard_checkpoint() returns trigger
language plpgsql volatile security invoker as $$
declare p integration.playback_capture_session%rowtype;
begin
  select * into p from integration.playback_capture_session where id=old.session_id;
  if p.evidence_version<>'app-rendered-position-v2' then return new; end if;
  if row(new.id,new.session_id,new.sequence,new.accepted_at,new.known_frames,
         new.lost_frames,new.terminal,new.terminal_reason,new.receipt_status,new.reservation_bytes)
     is distinct from row(old.id,old.session_id,old.sequence,old.accepted_at,old.known_frames,
         old.lost_frames,old.terminal,old.terminal_reason,old.receipt_status,old.reservation_bytes)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture checkpoint is immutable' using errcode='23514';
  end if;
  if row(new.evidence,new.digest,new.receipt_body,new.evidence_redacted)
     is not distinct from row(old.evidence,old.digest,old.receipt_body,old.evidence_redacted) then
    return new;
  end if;
  if not old.evidence_redacted and new.evidence_redacted and new.digest is null
     and new.evidence=old.evidence-'owner_uuid'
     and new.receipt_body=old.receipt_body-'digest'
     and (p.account_id is null or not exists(select 1 from app.accounts where id=p.account_id)) then
    return new;
  end if;
  raise exception 'capture checkpoint is immutable' using errcode='23514';
end;
$$;
create trigger playback_capture_v2_checkpoint_immutable before update
  on integration.playback_capture_checkpoint for each row
  execute function integration.playback_capture_v2_guard_checkpoint();

create function integration.playback_capture_v2_assert_session(sid bigint) returns void
language plpgsql volatile security invoker as $$
declare p integration.playback_capture_session%rowtype;
        o integration.playback_capture_owner%rowtype;
begin
  select * into p from integration.playback_capture_session where id=sid;
  if not found then return; end if;
  if p.evidence_version='app-rendered-position-v1' then
    if p.owner_id is not null or p.owner_uuid is not null or p.reservation_bytes<>256 then
      raise exception 'invalid legacy capture binding' using errcode='23514';
    end if;
    return;
  end if;
  if p.reservation_bytes<>384 then
    raise exception 'invalid capture charge' using errcode='23514';
  end if;
  if p.account_id is null then
    if p.owner_id is not null or p.owner_uuid is not null or p.account_budget_id is not null then
      raise exception 'invalid redacted capture binding' using errcode='23514';
    end if;
    return;
  end if;
  select * into o from integration.playback_capture_owner where id=p.owner_id;
  if not found or row(o.account_id,o.library_id,o.device_uuid,o.auth_session_guard,
                       o.owner_uuid,o.account_budget_id)
       is distinct from row(p.account_id,p.library_id,p.device_uuid,p.auth_session_guard,
                            p.owner_uuid,p.account_budget_id)
     or not exists(select 1 from integration.playback_capture_budget
                    where id=p.account_budget_id and account_id=p.account_id and not is_global) then
    raise exception 'invalid capture owner binding' using errcode='23514';
  end if;
end;
$$;

create function integration.playback_capture_v2_assert_run(rid bigint) returns void
language plpgsql volatile security invoker as $$
declare r integration.playback_capture_run%rowtype;
        c integration.playback_capture_checkpoint%rowtype;
        p integration.playback_capture_session%rowtype;
        body jsonb;
begin
  select * into r from integration.playback_capture_run where id=rid;
  if not found then return; end if;
  select * into c from integration.playback_capture_checkpoint where id=r.checkpoint_id;
  select * into p from integration.playback_capture_session where id=c.session_id;
  perform integration.playback_capture_v2_assert_session(p.id);
  if p.evidence_version='app-rendered-position-v1' then
    if r.owner_id is not null or r.binding_serial is not null or r.generation is not null
       or r.stream_id is not null or r.source_base48 is not null
       or r.continuity_serial is not null or r.reservation_bytes<>128 then
      raise exception 'invalid legacy capture run' using errcode='23514';
    end if;
    return;
  end if;
  body := c.evidence->'runs'->r.run_index;
  if r.owner_id is distinct from p.owner_id
     or r.account_budget_id is distinct from p.account_budget_id
     or r.reservation_bytes<>320
     or r.binding_serial is null or r.generation is null or r.stream_id is null
     or r.source_base48 is null or r.continuity_serial is null
     or r.source_start48<r.source_base48
     or jsonb_build_array(r.source_start48,r.frames,r.output_start,r.ordinal_start,r.epoch,
                         r.binding_serial,r.generation,r.stream_id,r.source_base48,r.continuity_serial)
        is distinct from jsonb_build_array(body->'source_start48',body->'frames',body->'output_start',
                         body->'ordinal_start',body->'epoch',body->'binding_serial',body->'generation',
                         body->'stream_id',body->'source_base48',body->'continuity_serial') then
    raise exception 'invalid capture run binding' using errcode='23514';
  end if;
end;
$$;

create function integration.playback_capture_v2_assert_anchor(aid bigint) returns void
language plpgsql volatile security invoker as $$
declare a integration.playback_capture_anchor%rowtype;
        p integration.playback_capture_session%rowtype;
begin
  select * into a from integration.playback_capture_anchor where id=aid;
  if not found then return; end if;
  select * into p from integration.playback_capture_session where id=a.session_id;
  if p.evidence_version='app-rendered-position-v2' then
    perform integration.playback_capture_v2_assert_session(p.id);
    if a.account_budget_id is distinct from p.account_budget_id then
      raise exception 'invalid capture anchor binding' using errcode='23514';
    end if;
  end if;
end;
$$;

create function integration.playback_capture_v2_assert_checkpoint(cid bigint, check_runs boolean)
returns void language plpgsql volatile security invoker as $$
declare c integration.playback_capture_checkpoint%rowtype;
        p integration.playback_capture_session%rowtype;
        g integration.playback_capture_loss%rowtype;
        n integer;
        seen integer := 0;
        body jsonb;
        child record;
begin
  select * into c from integration.playback_capture_checkpoint where id=cid;
  -- Skip only the authoritative checkpoint, never a vanished loss-row key.
  if not found then return; end if;
  select * into p from integration.playback_capture_session where id=c.session_id;
  perform integration.playback_capture_v2_assert_session(p.id);
  if p.evidence_version='app-rendered-position-v1' then
    if c.evidence_redacted or c.digest is null
       or exists(select 1 from integration.playback_capture_loss where checkpoint_id=c.id) then
      raise exception 'invalid legacy checkpoint projection' using errcode='23514';
    end if;
  else
    if c.account_budget_id is distinct from p.account_budget_id
       or jsonb_typeof(c.evidence->'gaps') is distinct from 'array'
       or jsonb_typeof(c.evidence->'runs') is distinct from 'array' then
      raise exception 'invalid capture checkpoint binding' using errcode='23514';
    end if;
    if p.account_id is null then
      if not c.evidence_redacted or c.digest is not null or c.evidence ? 'owner_uuid'
         or c.receipt_body ? 'digest' then
        raise exception 'invalid capture redaction' using errcode='23514';
      end if;
    elsif c.evidence_redacted or c.evidence->>'owner_uuid' is distinct from p.owner_uuid::text
          or c.digest is null or c.receipt_body->>'digest' is distinct from c.digest then
      raise exception 'invalid capture checkpoint identity' using errcode='23514';
    end if;
    n := jsonb_array_length(c.evidence->'gaps');
    if n>8 or jsonb_array_length(c.evidence->'runs')>256 then
      raise exception 'invalid capture projection size' using errcode='23514';
    end if;
    for g in select * from integration.playback_capture_loss
              where checkpoint_id=c.id order by gap_index loop
      body := c.evidence->'gaps'->g.gap_index;
      if g.gap_index<>seen or g.gap_index>=n
         or g.owner_id is distinct from p.owner_id
         or g.account_budget_id is distinct from p.account_budget_id
         or jsonb_build_array(g.ordinal_start,g.ordinal_end,g.output_start,g.output_end)
            is distinct from jsonb_build_array(body->'ordinal_start',body->'ordinal_end',
                                               body->'output_start',body->'output_end') then
        raise exception 'invalid capture loss projection' using errcode='23514';
      end if;
      seen := seen+1;
    end loop;
    if seen<>n then
      raise exception 'incomplete capture loss projection' using errcode='23514';
    end if;
  end if;
  if check_runs then
    for child in select id from integration.playback_capture_run where checkpoint_id=c.id loop
      perform integration.playback_capture_v2_assert_run(child.id);
    end loop;
  end if;
end;
$$;

create function integration.playback_capture_v2_check_graph() returns trigger
language plpgsql volatile security invoker as $$
declare child record;
        o integration.playback_capture_owner%rowtype;
begin
  if tg_table_name='playback_capture_loss' then
    if tg_op in ('UPDATE','DELETE') then
      perform integration.playback_capture_v2_assert_checkpoint(old.checkpoint_id,false);
    end if;
    if tg_op='INSERT' or (tg_op='UPDATE' and new.checkpoint_id is distinct from old.checkpoint_id) then
      perform integration.playback_capture_v2_assert_checkpoint(new.checkpoint_id,false);
    end if;
  elsif tg_table_name='playback_capture_checkpoint' then
    perform integration.playback_capture_v2_assert_checkpoint(new.id,true);
    if tg_op='UPDATE' and new.session_id is distinct from old.session_id then
      perform integration.playback_capture_v2_assert_session(old.session_id);
    end if;
  elsif tg_table_name='playback_capture_run' then
    perform integration.playback_capture_v2_assert_run(new.id);
  elsif tg_table_name='playback_capture_anchor' then
    perform integration.playback_capture_v2_assert_anchor(new.id);
  elsif tg_table_name='playback_capture_session' then
    perform integration.playback_capture_v2_assert_session(new.id);
    -- Ordinary progress updates do not rescan an entire retained parent.
    if tg_op='INSERT' or row(new.account_id,new.library_id,new.owner_id,new.owner_uuid,
       new.device_uuid,new.auth_session_guard,new.account_budget_id,new.evidence_version)
       is distinct from row(old.account_id,old.library_id,old.owner_id,old.owner_uuid,
       old.device_uuid,old.auth_session_guard,old.account_budget_id,old.evidence_version) then
      for child in select id from integration.playback_capture_checkpoint where session_id=new.id loop
        perform integration.playback_capture_v2_assert_checkpoint(child.id,true);
      end loop;
      for child in select id from integration.playback_capture_anchor where session_id=new.id loop
        perform integration.playback_capture_v2_assert_anchor(child.id);
      end loop;
    end if;
  elsif tg_table_name='playback_capture_owner' then
    select * into o from integration.playback_capture_owner
      where id=case when tg_op='DELETE' then old.id else new.id end;
    if found then
      if not exists(select 1 from integration.playback_capture_budget
                     where id=o.account_budget_id and account_id=o.account_id and not is_global) then
        raise exception 'invalid retained capture owner' using errcode='23514';
      end if;
      for child in select id from integration.playback_capture_session where owner_id=o.id loop
        perform integration.playback_capture_v2_assert_session(child.id);
      end loop;
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger playback_capture_owner_final after insert or update or delete
  on integration.playback_capture_owner deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();
create constraint trigger playback_capture_session_final after insert or update
  on integration.playback_capture_session deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();
create constraint trigger playback_capture_checkpoint_final after insert or update
  on integration.playback_capture_checkpoint deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();
create constraint trigger playback_capture_run_final after insert or update
  on integration.playback_capture_run deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();
create constraint trigger playback_capture_anchor_final after insert or update
  on integration.playback_capture_anchor deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();
create constraint trigger playback_capture_loss_final after insert or update or delete
  on integration.playback_capture_loss deferrable initially deferred for each row
  execute function integration.playback_capture_v2_check_graph();

create trigger playback_capture_owner_release after delete on integration.playback_capture_owner
  for each row execute function integration.playback_capture_release_charge();
create trigger playback_capture_loss_release after delete on integration.playback_capture_loss
  for each row execute function integration.playback_capture_release_charge();

create function integration.playback_capture_v2_cleanup_owner() returns trigger
language plpgsql volatile security invoker as $$
declare o integration.playback_capture_owner%rowtype;
begin
  if old.owner_id is null then return null; end if;
  select * into o from integration.playback_capture_owner where id=old.owner_id;
  if not found then return null; end if;
  -- Nonlocking owner lookup, then the established account -> global budget
  -- order, before owner DELETE. No new live-account anonymization path.
  perform id from integration.playback_capture_budget
    where id=o.account_budget_id and not is_global for update;
  perform id from integration.playback_capture_budget where is_global for update;
  if not exists(select 1 from integration.playback_capture_session where owner_id=o.id) then
    delete from integration.playback_capture_owner where id=o.id;
  end if;
  return null;
end;
$$;
create constraint trigger playback_capture_owner_cleanup after delete
  on integration.playback_capture_session deferrable initially deferred for each row
  execute function integration.playback_capture_v2_cleanup_owner();

create table integration.playback_capture_history_revision (
  account_id bigint primary key references app.accounts(id) on delete cascade,
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  append_revision bigint not null check (append_revision>=0),
  invalidation_revision bigint not null check (invalidation_revision>=0),
  proof_revision bigint not null check (proof_revision>=0),
  raw_checkpoint_cut bigint check (raw_checkpoint_cut>0),
  reservation_bytes bigint not null check (reservation_bytes=1024),
  check ((append_revision=0)=(raw_checkpoint_cut is null))
);
create index playback_capture_history_revision_budget_ref
  on integration.playback_capture_history_revision(account_budget_id)
  where account_budget_id is not null;
create trigger playback_capture_history_revision_release after delete
  on integration.playback_capture_history_revision for each row
  execute function integration.playback_capture_release_charge();

create function integration.playback_capture_history_guard_revision() returns trigger
language plpgsql volatile security invoker as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from app.accounts where id=old.account_id) then
      raise exception 'live capture history revision deletion is unsupported' using errcode='23514';
    end if;
    return old;
  end if;
  if row(new.account_id,new.reservation_bytes) is distinct from row(old.account_id,old.reservation_bytes)
     or (new.account_budget_id is distinct from old.account_budget_id and new.account_budget_id is not null)
     or new.append_revision<old.append_revision
     or new.invalidation_revision<old.invalidation_revision or new.proof_revision<old.proof_revision
     or (old.raw_checkpoint_cut is not null
         and (new.raw_checkpoint_cut is null or new.raw_checkpoint_cut<old.raw_checkpoint_cut)) then
    raise exception 'invalid capture history revision mutation' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger playback_capture_history_revision_guard before update or delete
  on integration.playback_capture_history_revision for each row
  execute function integration.playback_capture_history_guard_revision();

create function integration.playback_capture_history_check_revision() returns trigger
language plpgsql volatile security invoker as $$
declare h integration.playback_capture_history_revision%rowtype;
begin
  select * into h from integration.playback_capture_history_revision where account_id=new.account_id;
  if not found then return null; end if;
  if not exists(select 1 from integration.playback_capture_budget b
      where b.id=h.account_budget_id and b.account_id=h.account_id and not b.is_global) then
    raise exception 'invalid capture history budget binding' using errcode='23514';
  end if;
  return null;
end;
$$;
create constraint trigger playback_capture_history_revision_final after insert or update
  on integration.playback_capture_history_revision deferrable initially deferred for each row
  execute function integration.playback_capture_history_check_revision();

create function integration.playback_capture_history_invalidate(aid bigint) returns void
language plpgsql volatile security invoker as $$
begin
  -- Account DELETE owns removal of the revision row. Do not block privacy
  -- redaction or account destruction on an exhausted soon-to-disappear counter.
  if aid is null or not exists(select 1 from app.accounts where id=aid) then return; end if;
  -- No row means unsupported/uninitialized history, never a usable zero cut.
  update integration.playback_capture_history_revision
     set invalidation_revision=invalidation_revision+1 where account_id=aid;
  -- Signed bigint overflow raises and rolls back the destructive transaction.
end;
$$;

create function integration.playback_capture_history_raw_mutation() returns trigger
language plpgsql volatile security invoker as $$
declare aid bigint;
begin
  if tg_table_name='playback_capture_owner' then
    aid := old.account_id;
    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.device_uuid,
        new.auth_session_guard,new.owner_uuid) is not distinct from
        row(old.id,old.account_id,old.library_id,old.device_uuid,old.auth_session_guard,old.owner_uuid)
      then return new; end if;
  elsif tg_table_name='playback_capture_session' then
    if old.evidence_version<>'app-rendered-position-v2' then
      if tg_op='DELETE' then return old; else return new; end if;
    end if;
    aid := old.account_id;
    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.auth_session_guard,
        new.device_uuid,new.capture_uuid,new.v1_session_uuid,new.evidence_version,
        new.owner_id,new.owner_uuid,new.original_track_id,new.original_album_id,
        new.original_file_id,new.original_root_id,new.disc_number,new.track_number,new.admitted_at)
      is not distinct from row(old.id,old.account_id,old.library_id,old.auth_session_guard,
        old.device_uuid,old.capture_uuid,old.v1_session_uuid,old.evidence_version,
        old.owner_id,old.owner_uuid,old.original_track_id,old.original_album_id,
        old.original_file_id,old.original_root_id,old.disc_number,old.track_number,old.admitted_at)
      then return new; end if;
    -- Ordinary progress and independently nullable live pointers are not frozen
    -- cut evidence. The H2 final current-track AND invalid-parent probes remain
    -- mandatory even with unchanged revisions; this trigger is no substitute.
  elsif tg_table_name='playback_capture_checkpoint' then
    select p.account_id into aid from integration.playback_capture_session p
      where p.id=old.session_id and p.evidence_version='app-rendered-position-v2';
    if tg_op='UPDATE' and row(new.id,new.session_id,new.sequence,new.digest,new.evidence,
        new.evidence_redacted,new.accepted_at,new.known_frames,new.lost_frames,
        new.terminal,new.terminal_reason,new.receipt_status,new.receipt_body)
      is not distinct from row(old.id,old.session_id,old.sequence,old.digest,old.evidence,
        old.evidence_redacted,old.accepted_at,old.known_frames,old.lost_frames,
        old.terminal,old.terminal_reason,old.receipt_status,old.receipt_body)
      then return new; end if;
  elsif tg_table_name in ('playback_capture_run','playback_capture_loss') then
    select p.account_id into aid from integration.playback_capture_checkpoint cp
      join integration.playback_capture_session p on p.id=cp.session_id
      where cp.id=old.checkpoint_id and p.evidence_version='app-rendered-position-v2';
    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')
        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;
  elsif tg_table_name='playback_capture_anchor' then
    select p.account_id into aid from integration.playback_capture_session p
      where p.id=old.session_id and p.evidence_version='app-rendered-position-v2';
    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')
        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;
  else
    raise exception 'unsupported capture history mutation owner' using errcode='23514';
  end if;
  perform integration.playback_capture_history_invalidate(aid);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

create trigger playback_capture_history_owner before update or delete
  on integration.playback_capture_owner for each row
  execute function integration.playback_capture_history_raw_mutation();
create trigger playback_capture_history_session before update or delete
  on integration.playback_capture_session for each row
  execute function integration.playback_capture_history_raw_mutation();
create trigger playback_capture_history_checkpoint before update or delete
  on integration.playback_capture_checkpoint for each row
  execute function integration.playback_capture_history_raw_mutation();
create trigger playback_capture_history_run before update or delete
  on integration.playback_capture_run for each row
  execute function integration.playback_capture_history_raw_mutation();
create trigger playback_capture_history_loss before update or delete
  on integration.playback_capture_loss for each row
  execute function integration.playback_capture_history_raw_mutation();
create trigger playback_capture_history_anchor before update or delete
  on integration.playback_capture_anchor for each row
  execute function integration.playback_capture_history_raw_mutation();

alter table integration.playback_capture_session
  drop constraint playback_capture_session_library_id_fkey;
alter table integration.playback_capture_owner
  drop constraint playback_capture_owner_library_id_fkey;
create index playback_capture_account_session_history
  on integration.playback_capture_session(account_id,evidence_version,id);

create table integration.playback_edition_selection (
  account_id bigint not null references app.accounts(id) on delete cascade,
  selection_ref uuid not null check (selection_ref<>'00000000-0000-0000-0000-000000000000'::uuid),
  originating_session_id bigint not null check (originating_session_id>0),
  original_library_id bigint not null check (original_library_id>0),
  original_album_id bigint not null check (original_album_id>0),
  membership_revision text not null check (membership_revision ~ '^[0-9a-f]{64}$'),
  canonical_membership text not null,
  provenance text not null check (octet_length(provenance)<=2048),
  created_at timestamptz not null,
  reservation_bytes bigint not null,
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  primary key(account_id,selection_ref),
  constraint playback_edition_selection_body check (
    octet_length(canonical_membership) between 1 and 262144 and
    reservation_bytes=2048+octet_length(canonical_membership)+octet_length(provenance))
);
create index playback_edition_selection_budget on integration.playback_edition_selection(account_budget_id)
  where account_budget_id is not null;

create table integration.playback_edition_capture (
  account_id bigint not null references app.accounts(id) on delete cascade,
  original_capture_session_id bigint not null check (original_capture_session_id>0),
  live_capture_session_id bigint references integration.playback_capture_session(id) on delete set null,
  selection_ref uuid not null,
  original_track_id bigint not null check (original_track_id>0),
  reservation_bytes bigint not null check (reservation_bytes=512),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  primary key(account_id,original_capture_session_id),
  constraint playback_edition_capture_selection foreign key(account_id,selection_ref)
    references integration.playback_edition_selection(account_id,selection_ref),
  check (live_capture_session_id is null or live_capture_session_id=original_capture_session_id)
);
create index playback_edition_capture_selection_ref on integration.playback_edition_capture(account_id,selection_ref);
create index playback_edition_capture_live on integration.playback_edition_capture(live_capture_session_id)
  where live_capture_session_id is not null;
create index playback_edition_capture_budget on integration.playback_edition_capture(account_budget_id)
  where account_budget_id is not null;

create function integration.playback_edition_guard() returns trigger
language plpgsql volatile security invoker as $$
declare current_budget bigint; aid bigint; actual jsonb;
begin
  if tg_op='DELETE' then aid:=old.account_id; else aid:=new.account_id; end if;
  if not exists(select 1 from app.accounts where id=aid) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then
    raise exception 'live edition selection deletion requires explicit retention policy' using errcode='23514';
  end if;
  if tg_table_name='playback_edition_selection' then
    select to_jsonb(s) into actual from integration.playback_edition_selection s
      where account_id=new.account_id and selection_ref=new.selection_ref;
    if actual is null then return new; end if;
    if tg_op='UPDATE' and new is distinct from old then
      raise exception 'edition selection is immutable' using errcode='23514';
    end if;
  elsif tg_table_name='playback_edition_capture' then
    select to_jsonb(s) into actual from integration.playback_edition_capture s
      where account_id=new.account_id and original_capture_session_id=new.original_capture_session_id;
    if actual is null then return new; end if;
    if tg_op='UPDATE' and ((to_jsonb(new)-'live_capture_session_id') is distinct from
        (to_jsonb(old)-'live_capture_session_id') or new.live_capture_session_id is not null) then
      raise exception 'capture selection identity is immutable' using errcode='23514';
    end if;
    if actual->>'live_capture_session_id' is not null and not exists(
      select 1 from integration.playback_capture_session p where p.id=(actual->>'live_capture_session_id')::bigint
        and p.account_id=new.account_id and p.original_track_id=new.original_track_id
        and p.evidence_version='app-rendered-position-v2') then
      raise exception 'capture selection owner mismatch' using errcode='23514';
    end if;
    if actual->>'live_capture_session_id' is null and exists(select 1 from integration.playback_capture_session
        where id=new.original_capture_session_id) then
      raise exception 'live capture cannot be detached' using errcode='23514';
    end if;
  else
    raise exception 'unsupported edition selection owner' using errcode='23514';
  end if;
  select id into current_budget from integration.playback_capture_budget
    where account_id=new.account_id and not is_global;
  if current_budget is null or (actual->>'account_budget_id')::bigint is distinct from current_budget then
    raise exception 'edition selection budget mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;
create constraint trigger playback_edition_selection_guard after insert or update or delete
  on integration.playback_edition_selection deferrable initially deferred
  for each row execute function integration.playback_edition_guard();
create constraint trigger playback_edition_capture_guard after insert or update or delete
  on integration.playback_edition_capture deferrable initially deferred
  for each row execute function integration.playback_edition_guard();

create function integration.playback_edition_unlink_revision() returns trigger
language plpgsql volatile security invoker as $$
begin
  if old.live_capture_session_id is not null and new.live_capture_session_id is null
      and exists(select 1 from app.accounts where id=new.account_id) then
    update integration.playback_capture_history_revision set proof_revision=proof_revision+1
      where account_id=new.account_id and proof_revision<9223372036854775807;
    if not found then
      raise exception 'capture proof revision unavailable' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger playback_edition_capture_unlink after update of live_capture_session_id
  on integration.playback_edition_capture for each row
  execute function integration.playback_edition_unlink_revision();
create trigger playback_edition_selection_release after delete on integration.playback_edition_selection
  for each row execute function integration.playback_capture_release_charge();
create trigger playback_edition_capture_release after delete on integration.playback_edition_capture
  for each row execute function integration.playback_capture_release_charge();

create table integration.playback_decoder_observation (
  account_id bigint not null references app.accounts(id) on delete cascade,
  observation_ref uuid not null,
  auth_session_guard text not null check(length(auth_session_guard) between 1 and 256),
  original_library_id bigint not null check(original_library_id>0),
  original_track_id bigint not null check(original_track_id>0),
  original_file_id bigint not null check(original_file_id>0),
  original_root_id bigint not null check(original_root_id>0),
  generation bigint not null check(generation between 1 and 2147483647),
  stream_id bigint not null check(stream_id between 1 and 2147483647),
  source_base48 bigint not null check(source_base48=0),
  coordinate_basis text not null default 'decoded-output-zero',
  requested_start48 bigint not null default 0 check(requested_start48 between 0 and 9007199254740991),
  check ((coordinate_basis='decoded-output-zero' and requested_start48=0)
      or (coordinate_basis='decoded-output-local' and requested_start48>0)),
  extent_frames48 bigint check(extent_frames48 between 1 and 9007199254740991),
  inventory_source_revision text not null check(inventory_source_revision ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  reservation_bytes bigint not null check(reservation_bytes=512),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  primary key(account_id,observation_ref)
);
create function integration.playback_decoder_observation_guard() returns trigger
language plpgsql security invoker as $$
begin
  if tg_op='INSERT' then
    if new.extent_frames48 is not null then
      raise exception 'EOF requires admitted open' using errcode='23514';
    end if;
    if not exists(select 1 from integration.playback_capture_budget
        where id=new.account_budget_id and account_id=new.account_id and not is_global) then
      raise exception 'invalid observation account budget' using errcode='23514';
    end if;
    return new;
  end if;
  if exists(select 1 from app.accounts where id=old.account_id) then
    if old.extent_frames48 is null and new.extent_frames48 is not null
       and (to_jsonb(new)-'extent_frames48')=(to_jsonb(old)-'extent_frames48') then
      return new;
    end if;
    raise exception 'decoder lineage immutable; EOF completion is one-way' using errcode='23514';
  end if;
  -- Only account-deletion FK cleanup may null the disappearing budget link.
  if (to_jsonb(new)-'account_budget_id') is distinct from (to_jsonb(old)-'account_budget_id')
     or new.account_budget_id is not null then
    raise exception 'invalid decoder observation cleanup' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger playback_decoder_observation_immutable before insert or update
  on integration.playback_decoder_observation for each row
  execute function integration.playback_decoder_observation_guard();
create function integration.playback_decoder_observation_invalidate() returns trigger
language plpgsql security invoker as $$
begin
  if exists(select 1 from app.accounts where id=old.account_id) then
    update integration.playback_capture_history_revision set proof_revision=proof_revision+1
      where account_id=old.account_id and proof_revision<9223372036854775807;
    if not found then raise exception 'capture revision unavailable' using errcode='23514'; end if;
  end if;
  return old;
end;
$$;
create trigger playback_decoder_observation_revision before delete
  on integration.playback_decoder_observation for each row
  execute function integration.playback_decoder_observation_invalidate();
create trigger playback_decoder_observation_release after delete
  on integration.playback_decoder_observation for each row
  execute function integration.playback_capture_release_charge();

create index playback_decoder_observation_local_version_extent
  on integration.playback_decoder_observation
    (account_id,original_library_id,original_file_id,inventory_source_revision,coordinate_basis,extent_frames48)
  where extent_frames48 is not null;
create index playback_capture_session_local_album
  on integration.playback_capture_session(account_id,library_id,original_album_id,id);

create table integration.playback_album_metrics_state (
 account_id bigint not null references app.accounts(id) on delete cascade,
 original_library_id bigint not null,
 original_album_id bigint not null,
 state_revision bigint not null check (state_revision between 1 and 9007199254740991),
 state jsonb not null check (jsonb_typeof(state)='object' and octet_length(state::text)<=4194304),
 updated_at timestamptz not null,
 reservation_bytes bigint not null check (reservation_bytes between 1024 and 8388608),
 account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
 primary key(account_id,original_library_id,original_album_id)
);
create function integration.playback_album_metrics_state_guard() returns trigger
language plpgsql security invoker as $$ begin
 if TG_OP='UPDATE' and not exists(select 1 from app.accounts where id=old.account_id) then
   if (to_jsonb(new)-'account_budget_id') is distinct from (to_jsonb(old)-'account_budget_id')
      or new.account_budget_id is not null then raise exception 'invalid account cleanup'; end if;
   return new;
 end if;
 if not exists(select 1 from integration.playback_capture_budget
     where id=new.account_budget_id and account_id=new.account_id and not is_global) then
   raise exception 'invalid derived metrics account budget';
 end if;
 if TG_OP='UPDATE' and (new.account_id<>old.account_id or
   new.original_library_id<>old.original_library_id or new.original_album_id<>old.original_album_id or
   new.state_revision<>old.state_revision+1 or new.reservation_bytes<old.reservation_bytes or
   new.account_budget_id is distinct from old.account_budget_id) then
   raise exception 'invalid derived metrics update';
 end if;
 if new.reservation_bytes<1024+octet_length(new.state::text) then
   raise exception 'unreserved derived metrics state';
 end if;
 return new;
end $$;
create trigger playback_album_metrics_state_guard before insert or update
 on integration.playback_album_metrics_state for each row execute function integration.playback_album_metrics_state_guard();
create trigger playback_album_metrics_state_release after delete
 on integration.playback_album_metrics_state for each row execute function integration.playback_capture_release_charge();
create index playback_capture_owner_local_metrics_page
 on integration.playback_capture_owner(account_id,library_id,id);

create table app.album_top_listening_settings (
  account_id bigint primary key references app.accounts(id) on delete restrict,
  completed_target bigint not null check (completed_target between 1 and 9007199254740991),
  revision bigint not null check (revision > 0),
  created_at timestamptz not null check (isfinite(created_at)),
  updated_at timestamptz not null check (isfinite(updated_at) and updated_at >= created_at)
);
create function app.guard_album_top_listening_settings()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if NEW.account_id is distinct from OLD.account_id
      or NEW.created_at is distinct from OLD.created_at
      or NEW.revision::numeric <> OLD.revision::numeric + 1
      or NEW.updated_at < OLD.updated_at then
    raise exception using errcode='23514',constraint='album_top_listening_settings_revision',
      message='Listening settings identity or revision transition is invalid';
  end if;
  return NEW;
end $$;
create trigger album_top_listening_settings_update before update on app.album_top_listening_settings
  for each row execute function app.guard_album_top_listening_settings();
revoke all on app.album_top_listening_settings from public;
revoke all on function app.guard_album_top_listening_settings() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_listening_settings from album_haven_readonly;
    revoke all on function app.guard_album_top_listening_settings() from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_listening_settings from album_haven_app;
    revoke all on function app.guard_album_top_listening_settings() from album_haven_app;
    grant select,insert on app.album_top_listening_settings to album_haven_app;
    grant update(completed_target,revision,updated_at) on app.album_top_listening_settings to album_haven_app;
    grant execute on function app.guard_album_top_listening_settings() to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.album_top_listening_settings to album_haven_migrator;
    grant execute on function app.guard_album_top_listening_settings() to album_haven_migrator;
  end if;
end $$;

alter table app.album_ratings add column native_rating_intent_at timestamptz;

alter table app.album_list_items add column listening_baseline_at timestamptz;
alter table app.album_list_items alter column listening_baseline_at
  set default clock_timestamp();


alter table app.album_list_item_progress add column listening_item_ref uuid;
alter table app.album_list_item_progress add column listening_baseline_at timestamptz;
alter table app.album_list_item_progress add constraint album_progress_listening_baseline_pair
  check ((listening_item_ref is null) = (listening_baseline_at is null));
$install_graph$;
      end if;
      if stage in ('C0','C9') then
        execute $absolute_coordinates$
alter table integration.playback_decoder_observation
  drop constraint playback_decoder_observation_check;
alter table integration.playback_decoder_observation
  add constraint playback_decoder_observation_check check (
    (coordinate_basis='decoded-output-zero' and requested_start48=0)
    or (coordinate_basis='decoded-output-local' and requested_start48>0)
    or (coordinate_basis='decoded-output-absolute-wav48' and requested_start48>0)
    or (coordinate_basis='decoded-output-absolute-flac48' and requested_start48>=0));
alter table integration.playback_decoder_observation
  add constraint playback_decoder_observation_absolute_wav48_v1
  check (coordinate_basis <> 'decoded-output-absolute-wav48' or requested_start48>0);
alter table integration.playback_decoder_observation
  add constraint playback_decoder_observation_absolute_flac48_v1
  check (coordinate_basis <> 'decoded-output-absolute-flac48' or requested_start48>=0);
$absolute_coordinates$;
      end if;
      if stage in ('C0','C9','CA') then
        execute $converted_coordinates$
alter table integration.playback_decoder_observation
  drop constraint playback_decoder_observation_check;
alter table integration.playback_decoder_observation
  add constraint playback_decoder_observation_check check (
    (coordinate_basis='decoded-output-zero' and requested_start48=0)
    or (coordinate_basis='decoded-output-local' and requested_start48>0)
    or (coordinate_basis='decoded-output-absolute-wav48' and requested_start48>0)
    or (coordinate_basis='decoded-output-absolute-flac48' and requested_start48>=0)
    or (coordinate_basis='decoded-output-flac441-swr48-v1'
      and requested_start48>=0 and requested_start48<137438953472));
alter table integration.playback_decoder_observation
  add constraint playback_decoder_observation_flac441_swr48_v1
  check (coordinate_basis <> 'decoded-output-flac441-swr48-v1'
    or (requested_start48>=0 and requested_start48<137438953472));
$converted_coordinates$;
      end if;
    end if;
  end loop;
end
$tracking_delivery$;
