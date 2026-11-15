-- UI-ARTQ: Album page setting "Show art quality alert on album details page".
-- Additive: existing rows keep today's behavior (the alert shows). Rollback: drop the column.
alter table app.user_appearance_preferences
    add column if not exists album_art_quality_alert text not null default 'enabled';

alter table app.user_appearance_preferences
    drop constraint if exists user_appearance_album_art_quality_alert_check;

alter table app.user_appearance_preferences
    add constraint user_appearance_album_art_quality_alert_check
    check (album_art_quality_alert in ('enabled', 'disabled'));
