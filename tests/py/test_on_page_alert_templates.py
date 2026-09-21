"""Server alerts retain the shared component without requiring JavaScript."""

from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader, select_autoescape


TEMPLATES = Path(__file__).resolve().parents[2] / "music_app" / "templates"


def environment():
    return Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape())


def test_shared_alert_escapes_content_and_limits_attributes():
    macro = environment().get_template("components/on-page-alert.html").module.on_page_alert
    html = macro(
        '<script>alert("message")</script>', title='<img src=x onerror="title">',
        severity='error', role='status', hidden=True,
        attributes={"id": 'notice" onclick="bad', "onclick": "bad()", "data-admin-form-error": ""},
    )
    assert 'class="on-page-alert on-page-alert--error"' in html
    assert 'role="status"' in html
    assert ' hidden' in html
    assert 'data-admin-form-error=""' in html
    assert '<script>' not in html and '<img' not in html
    assert '&lt;script&gt;' in html and '&#34;' in html
    assert ' onclick="' not in html


@pytest.mark.parametrize("name,context,message", [
    ("login.html", {"failed": True}, "Sign-in failed."),
    ("password-reset.html", {"password_invalid": True}, "Choose a different password"),
    ("account-invitation.html", {"valid": True, "password_invalid": True}, "Choose a different password"),
])
def test_auth_errors_render_component_and_forms_without_javascript(name, context, message):
    html = environment().get_template(name).render(
        **context, csrf_token='unsafe"<token>', return_to='/', password_minlength=8,
        password_maxlength=128,
    )
    assert 'on-page-alert on-page-alert--error' in html
    assert 'role="alert"' in html and message in html
    assert '/static/css/runtime/alert-components.css' in html
    assert 'method="post"' in html
    assert 'name="csrf_token" value="unsafe&#34;&lt;token&gt;"' in html


def test_component_action_slot_preserves_post_and_csrf():
    html = environment().from_string('''
      {% from "components/on-page-alert.html" import on_page_alert %}
      {% from "partials/button.html" import ui_button %}
      {% call on_page_alert('Account suggestion', role='status') %}
      <form method="post" action="/account/password-suggestion/dismiss">
      <input name="csrf_token" value="{{ token }}">{{ ui_button('Dismiss', type='submit', size='small') }}
      </form>{% endcall %}
    ''').render(token='<csrf>')
    assert 'class="on-page-alert__actions"' in html
    assert 'action="/account/password-suggestion/dismiss"' in html
    assert 'value="&lt;csrf&gt;"' in html
    assert 'type="submit" class="button ui-button ui-button--secondary ui-button--small"' in html


@pytest.mark.parametrize("name,context,title", [
    ("password-recovery.html", {"sent": True}, "Check your email"),
    ("password-reset.html", {"completed": True}, "Password changed"),
])
def test_recovery_success_keeps_heading_and_shared_status(name, context, title):
    html = environment().get_template(name).render(**context)
    assert f'<h1 id="recovery-title">{title}</h1>' in html
    assert 'on-page-alert on-page-alert--info recovery-sent' in html
    assert 'role="status"' in html
