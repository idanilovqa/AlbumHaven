alter table app.user_appearance_preferences
    add column loop_control_style text not null default 'capsule'
    check (loop_control_style in ('capsule', 'companion'));
