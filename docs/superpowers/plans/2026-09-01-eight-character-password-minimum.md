# Eight-character Password Minimum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make eight Unicode code points the default and lowest configurable password length across every Album Haven credential-creation flow.

**Architecture:** Keep the policy centralized in `auth_config.py` and `auth_passwords.py`, then make the three new-password HTML surfaces reflect the same boundary. Preserve every other password check and update the owner-facing setup documentation.

**Tech Stack:** Python 3.11, pytest, Starlette/Jinja HTML templates, Markdown documentation.

## Global Constraints

- Eight Unicode code points is the default and lowest configurable password length.
- The maximum remains 256 Unicode code points and 1,024 UTF-8 bytes.
- Pwned Passwords and account-context rejection remain enabled.
- Existing credentials are not rewritten.
- Production code changes follow a witnessed RED-GREEN test cycle.

---

### Task 1: Central password-policy boundary

**Files:**
- Modify: `tests/py/test_auth_passwords.py`
- Modify: `tests/py/test_auth_config.py`
- Modify: `music_app/services/auth_passwords.py`
- Modify: `music_app/services/auth_config.py`

**Interfaces:**
- Consumes: `validate_password(raw, *, username, email, breached_checker)` and `build_auth_config(env)`.
- Produces: a default and configuration floor of 8 through the existing `password.min_codepoints` contract.

- [ ] **Step 1: Write failing boundary tests**

Change the out-of-bounds password case from `"x" * 14` to `"x" * 7`, add an explicit otherwise-safe eight-character acceptance case, change the weak configured minimum from `14` to `7`, and assert that configured `8` is accepted:

```python
def test_validation_accepts_eight_codepoints(passwords):
    assert _validate(passwords, "u7!Qz2#v") == "u7!Qz2#v"


def test_auth_config_accepts_eight_character_password_floor(contracts):
    auth_config, _ = contracts
    config = auth_config.build_auth_config(
        _auth_env(ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS="8")
    )
    assert config["password"]["min_codepoints"] == 8
```

- [ ] **Step 2: Run the focused tests and witness RED**

Run:

```powershell
python -m pytest tests/py/test_auth_passwords.py tests/py/test_auth_config.py -q
```

Expected: the eight-character acceptance and configured-floor tests fail because the current minimum is 15.

- [ ] **Step 3: Implement the minimal policy change**

Set `_MIN_CODEPOINTS = 8` in `auth_passwords.py`. In `build_auth_config`, change the default and minimum for `ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS` to 8:

```python
"min_codepoints": _integer(
    env, "ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS", 8, minimum=8
),
```

- [ ] **Step 4: Run the focused tests and witness GREEN**

Run the same pytest command. Expected: all tests pass.

- [ ] **Step 5: Commit the central policy change**

```powershell
git add -- tests/py/test_auth_passwords.py tests/py/test_auth_config.py music_app/services/auth_passwords.py music_app/services/auth_config.py
git commit -m "feat(auth): allow eight-character passwords"
```

### Task 2: Password forms and owner documentation

**Files:**
- Modify: `tests/py/test_auth_asgi.py`
- Modify: `music_app/templates/account-invitation.html`
- Modify: `music_app/templates/password-reset.html`
- Modify: `music_app/templates/account.html`
- Modify: `docs/local-auth-setup-and-manual-tests.md`

**Interfaces:**
- Consumes: the server-side eight-code-point boundary from Task 1.
- Produces: HTML new-password inputs with `minlength="8"` and matching owner-facing text.

- [ ] **Step 1: Add failing rendered-form assertions**

In the existing successful invitation and reset form response tests, assert that both new-password inputs include `minlength="8"`. In the account page test, assert that the new and confirmation inputs include the same attribute.

```python
assert response.text.count('minlength="8"') >= 2
```

- [ ] **Step 2: Run the focused rendered-route tests and witness RED**

Run:

```powershell
python -m pytest tests/py/test_auth_asgi.py -q
```

Expected: the new assertions fail because the invitation and account forms omit the attribute and the reset form still uses 15.

- [ ] **Step 3: Update forms and documentation**

Add `minlength="8"` to the new and confirmation password inputs in all three templates. Replace reset copy with:

```html
<p>Use at least 8 characters and choose a password you do not use elsewhere.</p>
```

Replace the setup guide policy sentence with:

```markdown
must contain 8 to 256 Unicode code points, must not contain the username or
email context, and must pass Pwned Passwords screening.
```

- [ ] **Step 4: Run focused tests and policy-text scan**

Run:

```powershell
python -m pytest tests/py/test_auth_asgi.py -q
rg -n "at least 15|15 to 256|minlength=\"15\"" music_app docs README.md
```

Expected: pytest passes and `rg` finds no password-policy remnants.

- [ ] **Step 5: Commit the form and documentation change**

```powershell
git add -- tests/py/test_auth_asgi.py music_app/templates/account-invitation.html music_app/templates/password-reset.html music_app/templates/account.html docs/local-auth-setup-and-manual-tests.md
git commit -m "docs(auth): advertise eight-character password minimum"
```

### Task 3: Regression verification and publication

**Files:**
- Verify only: all changed files and branch state.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a tested commit range ready to push to the existing unmerged PR.

- [ ] **Step 1: Run focused authentication suites**

```powershell
python -m pytest tests/py/test_auth_passwords.py tests/py/test_auth_config.py tests/py/test_auth_asgi.py tests/py/test_bootstrap_auth_owner_script.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run required broader suites sequentially**

```powershell
npm test
npm run test:js:all
```

Expected: both commands pass; never run more than one pytest process at a time.

- [ ] **Step 3: Verify repository scope**

```powershell
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors; only the owner's pre-existing `AGENTS.md` and `.codex-remote-attachments/` remain outside the commits.

- [ ] **Step 4: Push the existing feature branch**

```powershell
git push origin 2026-08-30-phase-7-local-auth
```

Expected: the open PR updates and remains unmerged.
