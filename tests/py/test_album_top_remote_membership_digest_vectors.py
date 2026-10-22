"""Literal legacy and typed wire/digest vectors independently hashed as JSON.

Expected normalized data was written without importing the implementation.
Canonical JSON was sorted by jq and hashed with sha256sum, without Python/app
execution. Do not regenerate expected data or digests from the code under test.
"""
import json

import pytest

from music_app.services.owned_album_tops import normalize_top_command


VECTORS = json.loads(r'''
[
  {
    "name": "legacy_create_defaults",
    "action": "create",
    "top_ref": null,
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "title": "  Top  "
    },
    "data": {
      "title": "Top",
      "description": "",
      "album_refs": []
    },
    "canonical": "{\"action\":\"create\",\"data\":{\"album_refs\":[],\"description\":\"\",\"title\":\"Top\"},\"top_ref\":null}",
    "digest": "ba585705c18d242dad857fd238e91fc35d600a8e0012a88e086bba685440f1b5"
  },
  {
    "name": "legacy_create_unicode",
    "action": "create",
    "top_ref": null,
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "title": "  Local Ω  ",
      "description": "A note",
      "album_refs": [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      ]
    },
    "data": {
      "title": "Local Ω",
      "description": "A note",
      "album_refs": [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      ]
    },
    "canonical": "{\"action\":\"create\",\"data\":{\"album_refs\":[\"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\"],\"description\":\"A note\",\"title\":\"Local Ω\"},\"top_ref\":null}",
    "digest": "cf9ab7d1ce010780700370921b3d2e0601cdcb6d23feef7c09c524e2e42e2eeb"
  },
  {
    "name": "legacy_add_order",
    "action": "add",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "9007199254740993",
      "album_refs": [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      ]
    },
    "data": {
      "revision": "9007199254740993",
      "album_refs": [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      ]
    },
    "canonical": "{\"action\":\"add\",\"data\":{\"album_refs\":[\"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\",\"cccccccc-cccc-4ccc-8ccc-cccccccccccc\"],\"revision\":\"9007199254740993\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "b679f6403c04777b198481c66fad711a7b9e6df885063f2c4cdd55b769fd91c2"
  },
  {
    "name": "legacy_save_header",
    "action": "save",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "title": "  Renamed Ω  ",
      "description": ""
    },
    "data": {
      "revision": "7",
      "title": "Renamed Ω",
      "description": ""
    },
    "canonical": "{\"action\":\"save\",\"data\":{\"description\":\"\",\"revision\":\"7\",\"title\":\"Renamed Ω\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "3df894269e0f0424784b6188489dba7aa0ce4ee6971dbca3d5aea51a5883c5b3"
  },
  {
    "name": "legacy_save_unselected_rows",
    "action": "save",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "items": [
        {
          "item_ref": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        },
        {
          "item_ref": null,
          "album_ref": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        }
      ]
    },
    "data": {
      "revision": "7",
      "items": [
        {
          "item_ref": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        },
        {
          "item_ref": null,
          "album_ref": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        }
      ]
    },
    "canonical": "{\"action\":\"save\",\"data\":{\"items\":[{\"album_ref\":\"cccccccc-cccc-4ccc-8ccc-cccccccccccc\",\"item_ref\":\"dddddddd-dddd-4ddd-8ddd-dddddddddddd\"},{\"album_ref\":\"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\",\"item_ref\":null}],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "b937c9382e033e49c2dd25250e00a58454b37f1d47b3f85551b9afbe84349bcc"
  },
  {
    "name": "legacy_save_selected_source",
    "action": "save",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "items": [
        {
          "item_ref": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "selected_local_album_id": 12,
          "selected_source_ref": "33333333-3333-4333-8333-333333333333"
        }
      ],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "data": {
      "revision": "7",
      "items": [
        {
          "item_ref": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "selected_local_album_id": 12,
          "selected_source_ref": "33333333-3333-4333-8333-333333333333"
        }
      ],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "canonical": "{\"action\":\"save\",\"data\":{\"evidence_revision\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"items\":[{\"album_ref\":\"cccccccc-cccc-4ccc-8ccc-cccccccccccc\",\"item_ref\":\"dddddddd-dddd-4ddd-8ddd-dddddddddddd\",\"selected_local_album_id\":12,\"selected_source_ref\":\"33333333-3333-4333-8333-333333333333\"}],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "ea0f0438a3e06b02aa77ab37851838c96d8f80665ad44b98b4eb1a981b3c98e4"
  },
  {
    "name": "legacy_enable_external_empty",
    "action": "enable_external",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "items": [],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "data": {
      "revision": "7",
      "items": [],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "canonical": "{\"action\":\"enable_external\",\"data\":{\"evidence_revision\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"items\":[],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "26f62cef2879f0c7fa0cc5106f7a72bf95d7daafe21a9bb5a4ba4ed0cb124619"
  },
  {
    "name": "legacy_revoke_external",
    "action": "revoke_external",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7"
    },
    "data": {
      "revision": "7"
    },
    "canonical": "{\"action\":\"revoke_external\",\"data\":{\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "dda24a5855e84731fc08c3b7a23f82416cb6d14ae5510c51a3718abc400dc0d9"
  },
  {
    "name": "legacy_remove",
    "action": "remove",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "item_refs": [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      ]
    },
    "data": {
      "revision": "7",
      "item_refs": [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      ]
    },
    "canonical": "{\"action\":\"remove\",\"data\":{\"item_refs\":[\"dddddddd-dddd-4ddd-8ddd-dddddddddddd\"],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "96f4273d14e1f6e0acbc56d9e7d2c9432db12009fa487074dc101e997e2767fa"
  },
  {
    "name": "legacy_reorder_empty",
    "action": "reorder",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "item_order": []
    },
    "data": {
      "revision": "7",
      "item_order": []
    },
    "canonical": "{\"action\":\"reorder\",\"data\":{\"item_order\":[],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "1ca29290026817ceae03c82331e01efb00d7e4da1dd800a61e2e136050d5ae1a"
  },
  {
    "name": "legacy_copy",
    "action": "copy",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "title": "  Copy Ω  "
    },
    "data": {
      "revision": "7",
      "title": "Copy Ω"
    },
    "canonical": "{\"action\":\"copy\",\"data\":{\"revision\":\"7\",\"title\":\"Copy Ω\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "2ffc015730a80e4565a6db482bcb1593fc29996c2aa1dfe54938c51cbdb01fe4"
  },
  {
    "name": "legacy_activity",
    "action": "set_activity",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "activity_revision": "0",
      "active": false
    },
    "data": {
      "activity_revision": "0",
      "active": false
    },
    "canonical": "{\"action\":\"set_activity\",\"data\":{\"active\":false,\"activity_revision\":\"0\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "2f2c759399b3074616ea746f6e990d2f41e2e7746ec1b63f5ebbb60266529ed9"
  },
  {
    "name": "legacy_manual_completion",
    "action": "set_manual_completion",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "progress_revision": "0",
      "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "completed": true
    },
    "data": {
      "progress_revision": "0",
      "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "completed": true
    },
    "canonical": "{\"action\":\"set_manual_completion\",\"data\":{\"album_ref\":\"cccccccc-cccc-4ccc-8ccc-cccccccccccc\",\"completed\":true,\"progress_revision\":\"0\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "576b9d3b0132f4337c34d456a126d8fd257794ec38b55fd51090d4dc105b9aa2"
  },
  {
    "name": "typed_create_mixed",
    "action": "create",
    "top_ref": null,
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "title": "  Mixed Ω  ",
      "draft_ref": "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "selections": [
        {
          "kind": "local_catalog",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        },
        {
          "kind": "remote_acquisition",
          "acquisition_ref": "11111111-1111-4111-8111-111111111111",
          "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    },
    "data": {
      "title": "Mixed Ω",
      "description": "",
      "draft_ref": "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "selections": [
        {
          "kind": "local_catalog",
          "album_ref": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        },
        {
          "kind": "remote_acquisition",
          "acquisition_ref": "11111111-1111-4111-8111-111111111111",
          "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    },
    "canonical": "{\"action\":\"create\",\"data\":{\"description\":\"\",\"draft_ref\":\"ffffffff-ffff-4fff-8fff-ffffffffffff\",\"selections\":[{\"album_ref\":\"cccccccc-cccc-4ccc-8ccc-cccccccccccc\",\"kind\":\"local_catalog\"},{\"acquisition_ref\":\"11111111-1111-4111-8111-111111111111\",\"evidence_version\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"kind\":\"remote_acquisition\"}],\"title\":\"Mixed Ω\"},\"top_ref\":null}",
    "digest": "ef300b969ce23c221dd6001b78584b2858accea02319c0ec6366d602863c6560"
  },
  {
    "name": "typed_add_retained",
    "action": "add",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "selections": [
        {
          "kind": "remote_retained",
          "admission_ref": "22222222-2222-4222-8222-222222222222",
          "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    },
    "data": {
      "revision": "7",
      "selections": [
        {
          "kind": "remote_retained",
          "admission_ref": "22222222-2222-4222-8222-222222222222",
          "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    },
    "canonical": "{\"action\":\"add\",\"data\":{\"revision\":\"7\",\"selections\":[{\"admission_ref\":\"22222222-2222-4222-8222-222222222222\",\"evidence_version\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"kind\":\"remote_retained\"}]},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "e8bf0bf975a4e34240c9bcfcd43aa71f8137d7c85d86b3eeca436e7af1f97542"
  },
  {
    "name": "typed_save_remote",
    "action": "save",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "item_selections": [
        {
          "kind": "new_remote",
          "source": {
            "kind": "remote_acquisition",
            "acquisition_ref": "11111111-1111-4111-8111-111111111111",
            "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          }
        }
      ]
    },
    "data": {
      "revision": "7",
      "item_selections": [
        {
          "kind": "new_remote",
          "source": {
            "kind": "remote_acquisition",
            "acquisition_ref": "11111111-1111-4111-8111-111111111111",
            "evidence_version": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          }
        }
      ]
    },
    "canonical": "{\"action\":\"save\",\"data\":{\"item_selections\":[{\"kind\":\"new_remote\",\"source\":{\"acquisition_ref\":\"11111111-1111-4111-8111-111111111111\",\"evidence_version\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"kind\":\"remote_acquisition\"}}],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "190676b7a6cf09441b095301d0a458a303d537a13ea7b4791bcdc5999ccc70a1"
  },
  {
    "name": "typed_save_clear",
    "action": "save",
    "top_ref": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "payload": {
      "request_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "revision": "7",
      "item_selections": [],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "data": {
      "revision": "7",
      "item_selections": [],
      "evidence_revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "canonical": "{\"action\":\"save\",\"data\":{\"evidence_revision\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"item_selections\":[],\"revision\":\"7\"},\"top_ref\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}",
    "digest": "0183101860cb8197906ef884b542fb857c2cfc7448d953e19e6b5292d1dd876d"
  }
]
''')


@pytest.mark.parametrize("vector", VECTORS, ids=lambda value: value["name"])
def test_literal_normalized_data_canonical_bytes_and_digest(vector):
    command = normalize_top_command(vector["action"], vector["payload"], top_ref=vector["top_ref"])
    assert command.request_key == vector["payload"]["request_key"]
    assert command.action == vector["action"] and command.top_ref == vector["top_ref"]
    assert command.data == vector["data"]
    canonical = json.dumps({"action": command.action, "top_ref": command.top_ref, "data": command.data},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    assert canonical.encode("utf-8") == vector["canonical"].encode("utf-8")
    assert command.digest == vector["digest"]
