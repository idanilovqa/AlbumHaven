# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: problematicFileNavigation.spec.js >> FTC-UTIL-PROBLEMS-001 rolls back failed exclusion creation and reversion
- Location: tests\e2e\specs\problematicFileNavigation.spec.js:624:1

# Error details

```
Test timeout of 240000ms exceeded.
```

```
Error: page.waitForResponse: Test timeout of 240000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "Album Haven library" [ref=e4] [cursor=pointer]:
        - /url: /
      - generic [ref=e10]:
        - combobox "Search music" [ref=e11]
        - button "Search" [ref=e13] [cursor=pointer]:
          - img [ref=e14]
      - generic [ref=e17]:
        - button "Cover art lookups" [ref=e18] [cursor=pointer]
        - button "Library status" [ref=e21] [cursor=pointer]:
          - generic [ref=e23]: ✓
        - button "Sources" [ref=e24] [cursor=pointer]:
          - img [ref=e26]
        - button "Settings" [ref=e29] [cursor=pointer]:
          - generic [ref=e30]: ⚙
    - complementary [ref=e31]:
      - heading "Artists" [level=2] [ref=e33]
      - generic [ref=e34]:
        - link "All artists 39" [ref=e35] [cursor=pointer]:
          - /url: /?surface=albums
          - generic [ref=e36]: All artists
          - generic [ref=e37]: "39"
        - link "!!! 1" [ref=e38] [cursor=pointer]:
          - /url: /?surface=albums&artist=%21%21%21&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e39]: "!!!"
          - generic [ref=e40]: "1"
        - link "*** 1" [ref=e41] [cursor=pointer]:
          - /url: /?surface=albums&artist=***&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e42]: "***"
          - generic [ref=e43]: "1"
        - link "Agents Of Mercy 10" [ref=e44] [cursor=pointer]:
          - /url: /?surface=albums&artist=Agents+Of+Mercy&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e45]: Agents Of Mercy
          - generic [ref=e46]: "10"
        - link "Album Haven Last.fm Fixture 1" [ref=e47] [cursor=pointer]:
          - /url: /?surface=albums&artist=Album+Haven+Last.fm+Fixture&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e48]: Album Haven Last.fm Fixture
          - generic [ref=e49]: "1"
        - link "Album Rating Contract 7" [ref=e50] [cursor=pointer]:
          - /url: /?surface=albums&artist=Album+Rating+Contract&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e51]: Album Rating Contract
          - generic [ref=e52]: "7"
        - link "Compilation Signal Guest 12" [ref=e53] [cursor=pointer]:
          - /url: /?surface=albums&artist=Compilation+Signal+Guest&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e54]: Compilation Signal Guest
          - generic [ref=e55]: "12"
        - link "Compilation Signal Lead 12" [ref=e56] [cursor=pointer]:
          - /url: /?surface=albums&artist=Compilation+Signal+Lead&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e57]: Compilation Signal Lead
          - generic [ref=e58]: "12"
        - link "Compilation Signal Lead / Compilation Signal Guest 10" [ref=e59] [cursor=pointer]:
          - /url: /?surface=albums&artist=Compilation+Signal+Lead+%2F+Compilation+Signal+Guest&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e60]: Compilation Signal Lead / Compilation Signal Guest
          - generic [ref=e61]: "10"
        - link "Control Signal Lead 12" [ref=e62] [cursor=pointer]:
          - /url: /?surface=albums&artist=Control+Signal+Lead&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e63]: Control Signal Lead
          - generic [ref=e64]: "12"
        - link "Control Signal Lead / Control Signal Partner 10" [ref=e65] [cursor=pointer]:
          - /url: /?surface=albums&artist=Control+Signal+Lead+%2F+Control+Signal+Partner&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e66]: Control Signal Lead / Control Signal Partner
          - generic [ref=e67]: "10"
        - link "Control Signal Partner 12" [ref=e68] [cursor=pointer]:
          - /url: /?surface=albums&artist=Control+Signal+Partner&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e69]: Control Signal Partner
          - generic [ref=e70]: "12"
        - link "E2E Rarity Artist 12" [ref=e71] [cursor=pointer]:
          - /url: /?surface=albums&artist=E2E+Rarity+Artist&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e72]: E2E Rarity Artist
          - generic [ref=e73]: "12"
        - link "Flaming Row 10" [ref=e74] [cursor=pointer]:
          - /url: /?surface=albums&artist=Flaming+Row&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e75]: Flaming Row
          - generic [ref=e76]: "10"
        - link "Frank Churchill / Leigh Harline / Larry Morey 1" [ref=e77] [cursor=pointer]:
          - /url: /?surface=albums&artist=Frank+Churchill+%2F+Leigh+Harline+%2F+Larry+Morey&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e78]: Frank Churchill / Leigh Harline / Larry Morey
          - generic [ref=e79]: "1"
        - link "Functional Balance Artist 02 18" [ref=e80] [cursor=pointer]:
          - /url: /?surface=albums&artist=Functional+Balance+Artist+02&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e81]: Functional Balance Artist 02
          - generic [ref=e82]: "18"
        - link "Functional Balance Artist 03 18" [ref=e83] [cursor=pointer]:
          - /url: /?surface=albums&artist=Functional+Balance+Artist+03&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e84]: Functional Balance Artist 03
          - generic [ref=e85]: "18"
        - link "Generated Problem Fixture 11" [ref=e86] [cursor=pointer]:
          - /url: /?surface=albums&artist=Generated+Problem+Fixture&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e87]: Generated Problem Fixture
          - generic [ref=e88]: "11"
        - link "Mastodon 10" [ref=e89] [cursor=pointer]:
          - /url: /?surface=albums&artist=Mastodon&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e90]: Mastodon
          - generic [ref=e91]: "10"
        - link "Metallica 10" [ref=e92] [cursor=pointer]:
          - /url: /?surface=albums&artist=Metallica&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e93]: Metallica
          - generic [ref=e94]: "10"
        - link "Morse Portnoy George 2" [ref=e95] [cursor=pointer]:
          - /url: /?surface=albums&artist=Morse+Portnoy+George&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e96]: Morse Portnoy George
          - generic [ref=e97]: "2"
        - link "Neal Morse 10" [ref=e98] [cursor=pointer]:
          - /url: /?surface=albums&artist=Neal+Morse&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e99]: Neal Morse
          - generic [ref=e100]: "10"
        - link "Neal Morse & The Resonance 10" [ref=e101] [cursor=pointer]:
          - /url: /?surface=albums&artist=Neal+Morse+%26+The+Resonance&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e102]: Neal Morse & The Resonance
          - generic [ref=e103]: "10"
        - link "Playback Start Signals 10" [ref=e104] [cursor=pointer]:
          - /url: /?surface=albums&artist=Playback+Start+Signals&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e105]: Playback Start Signals
          - generic [ref=e106]: "10"
        - link "Roine Stolt 10" [ref=e107] [cursor=pointer]:
          - /url: /?surface=albums&artist=Roine+Stolt&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e108]: Roine Stolt
          - generic [ref=e109]: "10"
        - link "Sia 12" [ref=e110] [cursor=pointer]:
          - /url: /?surface=albums&artist=Sia&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e111]: Sia
          - generic [ref=e112]: "12"
        - link "Sia / Soundtrack Signal Guest 10" [ref=e113] [cursor=pointer]:
          - /url: /?surface=albums&artist=Sia+%2F+Soundtrack+Signal+Guest&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e114]: Sia / Soundtrack Signal Guest
          - generic [ref=e115]: "10"
        - link "Signal Family Lead 1" [ref=e116] [cursor=pointer]:
          - /url: /?surface=albums&artist=Signal++Family+Lead&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e117]: Signal Family Lead
          - generic [ref=e118]: "1"
        - link "Signal Family Relative 1" [ref=e119] [cursor=pointer]:
          - /url: /?surface=albums&artist=Signal+Family+Relative&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e120]: Signal Family Relative
          - generic [ref=e121]: "1"
        - link "Solo Voice 17" [ref=e122] [cursor=pointer]:
          - /url: /?surface=albums&artist=Solo+Voice&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e123]: Solo Voice
          - generic [ref=e124]: "17"
        - link "Soundtrack Signal Guest 12" [ref=e125] [cursor=pointer]:
          - /url: /?surface=albums&artist=Soundtrack+Signal+Guest&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e126]: Soundtrack Signal Guest
          - generic [ref=e127]: "12"
        - link "The Flower Kings 10" [ref=e128] [cursor=pointer]:
          - /url: /?surface=albums&artist=The+Flower+Kings&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e129]: The Flower Kings
          - generic [ref=e130]: "10"
        - link "The Neal Morse Band 10" [ref=e131] [cursor=pointer]:
          - /url: /?surface=albums&artist=The+Neal+Morse+Band&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e132]: The Neal Morse Band
          - generic [ref=e133]: "10"
        - link "Transatlantic 18" [ref=e134] [cursor=pointer]:
          - /url: /?surface=albums&artist=Transatlantic&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e135]: Transatlantic
          - generic [ref=e136]: "18"
        - link "U.D.O. 2" [ref=e137] [cursor=pointer]:
          - /url: /?surface=albums&artist=U.D.O.&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e138]: U.D.O.
          - generic [ref=e139]: "2"
        - link "Various Artists 29" [ref=e140] [cursor=pointer]:
          - /url: /?surface=albums&artist=Various+Artists&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e141]: Various Artists
          - generic [ref=e142]: "29"
        - link "Ария 11" [ref=e143] [cursor=pointer]:
          - /url: /?surface=albums&artist=%D0%90%D1%80%D0%B8%D1%8F&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e144]: Ария
          - generic [ref=e145]: "11"
        - link "Борис 1" [ref=e146] [cursor=pointer]:
          - /url: /?surface=albums&artist=%D0%91%D0%BE%D1%80%D0%B8%D1%81&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e147]: Борис
          - generic [ref=e148]: "1"
        - link "ДДТ 60" [ref=e149] [cursor=pointer]:
          - /url: /?surface=albums&artist=%D0%94%D0%94%D0%A2&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e150]: ДДТ
          - generic [ref=e151]: "60"
        - link "東京事変 1" [ref=e152] [cursor=pointer]:
          - /url: /?surface=albums&artist=%E6%9D%B1%E4%BA%AC%E4%BA%8B%E5%A4%89&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals
          - generic [ref=e153]: 東京事変
          - generic [ref=e154]: "1"
    - main [ref=e155]:
      - region "Gallery controls" [ref=e156]:
        - generic [ref=e157]:
          - generic [ref=e159]: Gallery
          - generic [ref=e160]: 39 artists · 400 albums
        - generic [ref=e161]:
          - group "Gallery view" [ref=e162]:
            - button "Cards" [pressed] [ref=e163] [cursor=pointer]:
              - img [ref=e164]
          - button "Album types" [ref=e167] [cursor=pointer]:
            - img [ref=e168]
      - generic [ref=e174]:
        - generic [ref=e175]:
          - generic [ref=e176]:
            - heading "!!!" [level=2] [ref=e177]
            - button "Information about !!!" [ref=e178] [cursor=pointer]:
              - generic [ref=e179]: i
            - generic [ref=e181]: 1 album
          - generic [ref=e184]:
            - button "Open Three Bangs tracklist" [ref=e185] [cursor=pointer]:
              - generic "Album cover for Three Bangs" [ref=e186]:
                - img "Album cover for Three Bangs" [ref=e187]
            - generic [ref=e188]:
              - heading "Three Bangs" [level=3] [ref=e189]:
                - button "Three Bangs" [ref=e190] [cursor=pointer]
              - generic [ref=e192]: "!!! · 2009"
              - generic [ref=e193]:
                - img "Album rating 2/10" [ref=e194]:
                  - generic [ref=e195]: ★
                  - generic [ref=e196]: ★
                  - generic [ref=e197]: ☆
                  - generic [ref=e198]: ☆
                  - generic [ref=e199]: ☆
                  - generic [ref=e200]: ☆
                  - generic [ref=e201]: ☆
                  - generic [ref=e202]: ☆
                  - generic [ref=e203]: ☆
                  - generic [ref=e204]: ☆
                - generic [ref=e205]: 2/10
              - generic [ref=e206]:
                - generic [ref=e207]: 18 tracks
                - generic [ref=e208]: 1m 12s
        - generic [ref=e209]:
          - generic [ref=e210]:
            - heading "***" [level=2] [ref=e211]
            - button "Information about ***" [ref=e212] [cursor=pointer]:
              - generic [ref=e213]: i
            - generic [ref=e215]: 1 album
          - generic [ref=e218]:
            - button "Open Three Stars tracklist" [ref=e219] [cursor=pointer]:
              - generic "Album cover for Three Stars" [ref=e220]:
                - img "Album cover for Three Stars" [ref=e221]
            - generic [ref=e222]:
              - heading "Three Stars" [level=3] [ref=e223]:
                - button "Three Stars" [ref=e224] [cursor=pointer]
              - generic [ref=e226]: "*** · 2010"
              - generic [ref=e227]:
                - img "Album rating 3/10" [ref=e228]:
                  - generic [ref=e229]: ★
                  - generic [ref=e230]: ★
                  - generic [ref=e231]: ★
                  - generic [ref=e232]: ☆
                  - generic [ref=e233]: ☆
                  - generic [ref=e234]: ☆
                  - generic [ref=e235]: ☆
                  - generic [ref=e236]: ☆
                  - generic [ref=e237]: ☆
                  - generic [ref=e238]: ☆
                - generic [ref=e239]: 3/10
              - generic [ref=e240]:
                - generic [ref=e241]: 18 tracks
                - generic [ref=e242]: 1m 12s
        - generic [ref=e243]:
          - generic [ref=e244]:
            - heading "Agents Of Mercy" [level=2] [ref=e245]
            - button "Information about Agents Of Mercy" [ref=e246] [cursor=pointer]:
              - generic [ref=e247]: i
            - generic [ref=e249]: 10 albums
          - generic [ref=e251]:
            - generic [ref=e252]:
              - button "Open Functional Fixture Album 329 tracklist" [ref=e253] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 329" [ref=e254]:
                  - img "Album cover for Functional Fixture Album 329" [ref=e255]
              - generic [ref=e256]:
                - heading "Functional Fixture Album 329" [level=3] [ref=e257]:
                  - button "Functional Fixture Album 329" [ref=e258] [cursor=pointer]
                - generic [ref=e260]: Agents Of Mercy · 1999
                - generic [ref=e261]:
                  - img "Album rating 3/10" [ref=e262]:
                    - generic [ref=e263]: ★
                    - generic [ref=e264]: ★
                    - generic [ref=e265]: ★
                    - generic [ref=e266]: ☆
                    - generic [ref=e267]: ☆
                    - generic [ref=e268]: ☆
                    - generic [ref=e269]: ☆
                    - generic [ref=e270]: ☆
                    - generic [ref=e271]: ☆
                    - generic [ref=e272]: ☆
                  - generic [ref=e273]: 3/10
                - generic [ref=e274]:
                  - generic [ref=e275]: 18 tracks
                  - generic [ref=e276]: 18m 00s
            - generic [ref=e277]:
              - button "Open Functional Fixture Album 330 tracklist" [ref=e278] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 330" [ref=e279]:
                  - img "Album cover for Functional Fixture Album 330" [ref=e280]
              - generic [ref=e281]:
                - heading "Functional Fixture Album 330" [level=3] [ref=e282]:
                  - button "Functional Fixture Album 330" [ref=e283] [cursor=pointer]
                - generic [ref=e285]: Agents Of Mercy · 2000
                - generic [ref=e286]:
                  - img "Album rating 4/10" [ref=e287]:
                    - generic [ref=e288]: ★
                    - generic [ref=e289]: ★
                    - generic [ref=e290]: ★
                    - generic [ref=e291]: ★
                    - generic [ref=e292]: ☆
                    - generic [ref=e293]: ☆
                    - generic [ref=e294]: ☆
                    - generic [ref=e295]: ☆
                    - generic [ref=e296]: ☆
                    - generic [ref=e297]: ☆
                  - generic [ref=e298]: 4/10
                - generic [ref=e299]:
                  - generic [ref=e300]: 18 tracks
                  - generic [ref=e301]: 18m 00s
            - generic [ref=e302]:
              - button "Open Functional Fixture Album 331 tracklist" [ref=e303] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 331" [ref=e304]:
                  - img "Album cover for Functional Fixture Album 331" [ref=e305]
              - generic [ref=e306]:
                - heading "Functional Fixture Album 331" [level=3] [ref=e307]:
                  - button "Functional Fixture Album 331" [ref=e308] [cursor=pointer]
                - generic [ref=e310]: Agents Of Mercy · 2001
                - generic [ref=e311]:
                  - img "Album rating 5/10" [ref=e312]:
                    - generic [ref=e313]: ★
                    - generic [ref=e314]: ★
                    - generic [ref=e315]: ★
                    - generic [ref=e316]: ★
                    - generic [ref=e317]: ★
                    - generic [ref=e318]: ☆
                    - generic [ref=e319]: ☆
                    - generic [ref=e320]: ☆
                    - generic [ref=e321]: ☆
                    - generic [ref=e322]: ☆
                  - generic [ref=e323]: 5/10
                - generic [ref=e324]:
                  - generic [ref=e325]: 18 tracks
                  - generic [ref=e326]: 18m 00s
            - generic [ref=e327]:
              - button "Open Functional Fixture Album 332 tracklist" [ref=e328] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 332" [ref=e329]
              - generic [ref=e330]:
                - heading "Functional Fixture Album 332" [level=3] [ref=e331]:
                  - button "Functional Fixture Album 332" [ref=e332] [cursor=pointer]
                - generic [ref=e334]: Agents Of Mercy · 2002
                - generic [ref=e335]:
                  - img "Album rating 6/10" [ref=e336]:
                    - generic [ref=e337]: ★
                    - generic [ref=e338]: ★
                    - generic [ref=e339]: ★
                    - generic [ref=e340]: ★
                    - generic [ref=e341]: ★
                    - generic [ref=e342]: ★
                    - generic [ref=e343]: ☆
                    - generic [ref=e344]: ☆
                    - generic [ref=e345]: ☆
                    - generic [ref=e346]: ☆
                  - generic [ref=e347]: 6/10
                - generic [ref=e348]:
                  - generic [ref=e349]: 18 tracks
                  - generic [ref=e350]: 18m 00s
        - generic [ref=e352]:
          - generic [ref=e353]:
            - heading "Album Haven Last.fm Fixture" [level=2] [ref=e354]
            - button "Information about Album Haven Last.fm Fixture" [ref=e355] [cursor=pointer]:
              - generic [ref=e356]: i
            - generic [ref=e358]: 1 album
          - generic [ref=e361]:
            - button "Open Signed Scrobble Journey tracklist" [ref=e362] [cursor=pointer]:
              - generic "Album cover for Signed Scrobble Journey" [ref=e363]
            - generic [ref=e364]:
              - heading "Signed Scrobble Journey" [level=3] [ref=e365]:
                - button "Signed Scrobble Journey" [ref=e366] [cursor=pointer]
              - generic [ref=e368]: Album Haven Last.fm Fixture · 2026
              - generic [ref=e369]:
                - img "Album rating 3/10" [ref=e370]:
                  - generic [ref=e371]: ★
                  - generic [ref=e372]: ★
                  - generic [ref=e373]: ★
                  - generic [ref=e374]: ☆
                  - generic [ref=e375]: ☆
                  - generic [ref=e376]: ☆
                  - generic [ref=e377]: ☆
                  - generic [ref=e378]: ☆
                  - generic [ref=e379]: ☆
                  - generic [ref=e380]: ☆
                - generic [ref=e381]: 3/10
              - generic [ref=e382]:
                - generic [ref=e383]: 18 tracks
                - generic [ref=e384]: 15m 48s
  - generic [ref=e387]:
    - generic [ref=e388]:
      - button "Collapse player" [ref=e389] [cursor=pointer]:
        - generic [ref=e390]: ‹
      - button "Open album details" [ref=e391] [cursor=pointer]
      - generic [ref=e392]:
        - button "Play" [disabled] [ref=e393] [cursor=pointer]: ▶
        - generic:
          - generic:
            - generic:
              - button "Create a loop" [disabled]
    - generic [ref=e396]:
      - slider "Playback position" [disabled]: "0"
      - text: Nothing is playing
  - complementary:
    - generic:
      - generic:
        - heading "Cover Art Look Ups" [level=3]
        - generic: Track long-running manual cover searches here.
      - generic:
        - button "Clear completed cover art lookups"
        - button "Close cover art lookups": ✕
  - dialog "Settings" [ref=e398]:
    - generic [ref=e399]:
      - tablist "Settings sections" [ref=e400]:
        - tab "Problematic files" [ref=e401] [cursor=pointer]
        - tab "Rules" [selected] [ref=e402] [cursor=pointer]
        - tab "Loops" [ref=e403] [cursor=pointer]
        - tab "Log History" [ref=e404] [cursor=pointer]
        - tab "Integrations" [ref=e405] [cursor=pointer]
        - tab "Appearance" [ref=e406] [cursor=pointer]
      - button "Close utilities" [ref=e407] [cursor=pointer]:
        - generic [ref=e408]: ✕
    - generic [ref=e409]:
      - complementary [ref=e410]:
        - searchbox "Search settings items" [ref=e415]
        - generic [ref=e416]:
          - button "Version exceptions Albums that should not be counted as versions of another album with the same title." [ref=e417] [cursor=pointer]:
            - generic [ref=e418]:
              - generic [ref=e419]: Version exceptions
              - generic [ref=e420]: Albums that should not be counted as versions of another album with the same title.
          - button "Problem exclusions Album or file problems excluded from Problematic Files." [ref=e421] [cursor=pointer]:
            - generic [ref=e422]:
              - generic [ref=e423]: Problem exclusions
              - generic [ref=e424]: Album or file problems excluded from Problematic Files.
      - tabpanel "Rules" [ref=e425]:
        - generic [ref=e426]:
          - heading "Problem exclusions" [level=3] [ref=e427]
          - paragraph [ref=e428]: Album or file problems excluded from Problematic Files.
          - generic [ref=e429]:
            - heading "ALBUM EXCLUSIONS" [level=4] [ref=e430]
            - table "Album exclusions" [ref=e431]:
              - row "Artist / Album Reason Actions" [ref=e432]:
                - columnheader "Artist / Album" [ref=e433]
                - columnheader "Reason" [ref=e434]
                - columnheader "Actions" [ref=e435]
              - rowgroup [ref=e436]:
                - row "Artist / Album Reason Actions" [ref=e437]:
                  - cell "Artist / Album" [ref=e438]:
                    - generic [ref=e439]: Generated Problem Fixture - ? - 2005
                  - cell "Reason" [ref=e440]:
                    - generic [ref=e441]: Undecoded characters
                  - cell "Actions" [ref=e442]:
                    - button "Revert rule" [ref=e443] [cursor=pointer]
                - row "Artist / Album Reason Actions" [ref=e444]:
                  - cell "Artist / Album" [ref=e445]:
                    - generic [ref=e446]: Neal Morse - Neal Morse Plays Pink Floyd - 2023
                  - cell "Reason" [ref=e447]:
                    - generic [ref=e448]: Missing cover art
                  - cell "Actions" [ref=e449]:
                    - button "Revert rule" [ref=e450] [cursor=pointer]
          - generic [ref=e451]:
            - heading "FILE EXCLUSIONS" [level=4] [ref=e452]
            - table "File exclusions" [ref=e453]:
              - row "Filename Reason Actions" [ref=e454]:
                - columnheader "Filename" [ref=e455]
                - columnheader "Reason" [ref=e456]
                - columnheader "Actions" [ref=e457]
              - rowgroup [ref=e458]:
                - row "Filename Reason Actions" [ref=e459]:
                  - cell "Filename" [ref=e460]:
                    - generic [ref=e461]: 01 - Track 1.mp3
                    - generic [ref=e462]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e463]:
                    - generic [ref=e464]: Encoding problem
                  - cell "Actions" [ref=e465]:
                    - button "Revert rule" [ref=e466] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e467]:
                  - cell "Filename" [ref=e468]:
                    - generic [ref=e469]: 02 - Track 2.mp3
                    - generic [ref=e470]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e471]:
                    - generic [ref=e472]: Encoding problem
                  - cell "Actions" [ref=e473]:
                    - button "Revert rule" [ref=e474] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e475]:
                  - cell "Filename" [ref=e476]:
                    - generic [ref=e477]: 03 - Track 3.mp3
                    - generic [ref=e478]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e479]:
                    - generic [ref=e480]: Encoding problem
                  - cell "Actions" [ref=e481]:
                    - button "Revert rule" [ref=e482] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e483]:
                  - cell "Filename" [ref=e484]:
                    - generic [ref=e485]: 04 - Track 4.mp3
                    - generic [ref=e486]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e487]:
                    - generic [ref=e488]: Encoding problem
                  - cell "Actions" [ref=e489]:
                    - button "Revert rule" [ref=e490] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e491]:
                  - cell "Filename" [ref=e492]:
                    - generic [ref=e493]: 05 - Track 5.mp3
                    - generic [ref=e494]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e495]:
                    - generic [ref=e496]: Encoding problem
                  - cell "Actions" [ref=e497]:
                    - button "Revert rule" [ref=e498] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e499]:
                  - cell "Filename" [ref=e500]:
                    - generic [ref=e501]: 06 - Track 6.mp3
                    - generic [ref=e502]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e503]:
                    - generic [ref=e504]: Encoding problem
                  - cell "Actions" [ref=e505]:
                    - button "Revert rule" [ref=e506] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e507]:
                  - cell "Filename" [ref=e508]:
                    - generic [ref=e509]: 07 - Track 7.mp3
                    - generic [ref=e510]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e511]:
                    - generic [ref=e512]: Encoding problem
                  - cell "Actions" [ref=e513]:
                    - button "Revert rule" [ref=e514] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e515]:
                  - cell "Filename" [ref=e516]:
                    - generic [ref=e517]: 08 - Track 8.mp3
                    - generic [ref=e518]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e519]:
                    - generic [ref=e520]: Encoding problem
                  - cell "Actions" [ref=e521]:
                    - button "Revert rule" [ref=e522] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e523]:
                  - cell "Filename" [ref=e524]:
                    - generic [ref=e525]: 09 - Track 9.mp3
                    - generic [ref=e526]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e527]:
                    - generic [ref=e528]: Encoding problem
                  - cell "Actions" [ref=e529]:
                    - button "Revert rule" [ref=e530] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e531]:
                  - cell "Filename" [ref=e532]:
                    - generic [ref=e533]: 10 - Track 10.mp3
                    - generic [ref=e534]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e535]:
                    - generic [ref=e536]: Encoding problem
                  - cell "Actions" [ref=e537]:
                    - button "Revert rule" [ref=e538] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e539]:
                  - cell "Filename" [ref=e540]:
                    - generic [ref=e541]: 11 - Track 11.mp3
                    - generic [ref=e542]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e543]:
                    - generic [ref=e544]: Encoding problem
                  - cell "Actions" [ref=e545]:
                    - button "Revert rule" [ref=e546] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e547]:
                  - cell "Filename" [ref=e548]:
                    - generic [ref=e549]: 12 - Track 12.mp3
                    - generic [ref=e550]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e551]:
                    - generic [ref=e552]: Encoding problem
                  - cell "Actions" [ref=e553]:
                    - button "Revert rule" [ref=e554] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e555]:
                  - cell "Filename" [ref=e556]:
                    - generic [ref=e557]: 13 - Track 13.mp3
                    - generic [ref=e558]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e559]:
                    - generic [ref=e560]: Encoding problem
                  - cell "Actions" [ref=e561]:
                    - button "Revert rule" [ref=e562] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e563]:
                  - cell "Filename" [ref=e564]:
                    - generic [ref=e565]: 14 - Track 14.mp3
                    - generic [ref=e566]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e567]:
                    - generic [ref=e568]: Encoding problem
                  - cell "Actions" [ref=e569]:
                    - button "Revert rule" [ref=e570] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e571]:
                  - cell "Filename" [ref=e572]:
                    - generic [ref=e573]: 15 - Track 15.mp3
                    - generic [ref=e574]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e575]:
                    - generic [ref=e576]: Encoding problem
                  - cell "Actions" [ref=e577]:
                    - button "Revert rule" [ref=e578] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e579]:
                  - cell "Filename" [ref=e580]:
                    - generic [ref=e581]: 16 - Track 16.mp3
                    - generic [ref=e582]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e583]:
                    - generic [ref=e584]: Encoding problem
                  - cell "Actions" [ref=e585]:
                    - button "Revert rule" [ref=e586] [cursor=pointer]
                - row "Filename Reason Actions" [ref=e587]:
                  - cell "Filename" [ref=e588]:
                    - generic [ref=e589]: 17 - Track 17.mp3
                    - generic [ref=e590]: Partial � Metadata And Cover
                  - cell "Reason" [ref=e591]:
                    - generic [ref=e592]: Encoding problem
                  - cell "Actions" [ref=e593]:
                    - button "Revert rule" [ref=e594] [cursor=pointer]
  - dialog "Revert rule?" [ref=e596]:
    - heading "Revert rule?" [level=3] [ref=e597]
    - generic [ref=e598]: Revert the rule for Neal Morse Plays Pink Floyd? This problem can appear again in Problems.
    - generic [ref=e599]:
      - button "No" [ref=e600] [cursor=pointer]
      - button "Yes" [ref=e601] [cursor=pointer]
```

# Test source

```ts
  54  |         return {
  55  |           headers: [],
  56  |           rows: [],
  57  |           actionTrack: '',
  58  |           reasonOrigins: [],
  59  |         };
  60  |       }
  61  |       // parity-check: allow-read-only-measurement-evaluate -- capture semantic table structure and geometry atomically
  62  |       return table.evaluate((element, selectors) => {
  63  |         return {
  64  |           headers: Array.from(element.querySelectorAll(selectors.headers), (node) => String(node.textContent || '').trim()),
  65  |           rows: Array.from(element.querySelectorAll(selectors.rows), (row) => String(row.textContent || '').trim()),
  66  |           actionTrack: getComputedStyle(element).getPropertyValue('--cdt-action-track').trim(),
  67  |           reasonOrigins: Array.from(element.querySelectorAll(selectors.reasons), (node) => (
  68  |             Math.round(node.getBoundingClientRect().left * 100) / 100
  69  |           )),
  70  |         };
  71  |       }, {
  72  |         headers: this.utilityRulesTab.columnHeaderSelector,
  73  |         rows: this.utilityRulesTab.keyedTableRowSelector,
  74  |         reasons: this.utilityRulesTab.reasonColumnSelector,
  75  |       });
  76  |     };
  77  |     return {
  78  |       album: await readTable(this.utilityRulesTab.albumExclusionsTable),
  79  |       file: await readTable(this.utilityRulesTab.fileExclusionsTable),
  80  |     };
  81  |   }
  82  | 
  83  |   async readProblemExclusionRows() {
  84  |     const readRows = async (table) => (
  85  |       (await this.utilityRulesTab.keyedRows(table).allTextContents())
  86  |         .map((value) => String(value || '').trim())
  87  |         .filter(Boolean)
  88  |     );
  89  |     return {
  90  |       album: await readRows(this.utilityRulesTab.albumExclusionsTable),
  91  |       file: await readRows(this.utilityRulesTab.fileExclusionsTable),
  92  |     };
  93  |   }
  94  | 
  95  |   async readProblemExclusionMobileLayout() {
  96  |     const readFirstRow = async (table) => {
  97  |       const row = this.utilityRulesTab.firstKeyedRow(table);
  98  |       // parity-check: allow-read-only-measurement-evaluate -- capture semantic mobile stacking and geometry atomically
  99  |       return row.evaluate((element, selectors) => {
  100 |         const target = element.querySelector(selectors.target);
  101 |         const reason = element.querySelector(selectors.reason);
  102 |         const action = element.querySelector(selectors.action);
  103 |         const rowBox = element.getBoundingClientRect();
  104 |         const targetBox = target?.getBoundingClientRect();
  105 |         const reasonBox = reason?.getBoundingClientRect();
  106 |         const actionBox = action?.getBoundingClientRect();
  107 |         return {
  108 |           reasonColumn: reason?.getAttribute('data-cdt-column') || '',
  109 |           reasonBelowTarget: Boolean(targetBox && reasonBox && reasonBox.top >= targetBox.bottom - 1),
  110 |           revertTopRight: Boolean(actionBox
  111 |             && Math.abs(actionBox.top - rowBox.top) <= 12
  112 |             && Math.abs(actionBox.right - rowBox.right) <= 12),
  113 |           visibleReasonLabelCount: Array.from(element.querySelectorAll(selectors.descendants)).filter((node) => (
  114 |             String(node.textContent || '').trim() === 'Reason'
  115 |             && getComputedStyle(node).display !== 'none'
  116 |             && getComputedStyle(node).visibility !== 'hidden'
  117 |           )).length,
  118 |         };
  119 |       }, {
  120 |         target: this.utilityRulesTab.targetColumnSelector,
  121 |         reason: this.utilityRulesTab.reasonColumnSelector,
  122 |         action: this.utilityRulesTab.actionColumnSelector,
  123 |         descendants: this.utilityRulesTab.allDescendantsSelector,
  124 |       });
  125 |     };
  126 |     return {
  127 |       album: await readFirstRow(this.utilityRulesTab.albumExclusionsTable),
  128 |       file: await readFirstRow(this.utilityRulesTab.fileExclusionsTable),
  129 |     };
  130 |   }
  131 | 
  132 |   async cancelRevertRuleContaining(text, expectedTarget) {
  133 |     const requests = [];
  134 |     const observe = (request) => {
  135 |       if (request.method() === 'POST'
  136 |         && new URL(request.url()).pathname === '/utilities/rules/problem-ignores/revert') requests.push(request);
  137 |     };
  138 |     const row = this.utilityRulesTab.exclusionRowContaining(text);
  139 |     this.utilityRulesTab.page.on('request', observe);
  140 |     try {
  141 |       await this.utilityRulesTab.revertButtonForRow(row).click();
  142 |       await expect(this.utilityRulesTab.revertConfirmation).toBeVisible();
  143 |       await expect(this.utilityRulesTab.revertConfirmation).toContainText(expectedTarget);
  144 |       await this.utilityRulesTab.revertNo.click();
  145 |       await expect(this.utilityRulesTab.revertConfirmation).toBeHidden();
  146 |       await expect(row).toBeVisible();
  147 |       expect(requests).toHaveLength(0);
  148 |     } finally {
  149 |       this.utilityRulesTab.page.off('request', observe);
  150 |     }
  151 |   }
  152 | 
  153 |   async revertRuleContaining(text) {
> 154 |     const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
      |                                                       ^ Error: page.waitForResponse: Test timeout of 240000ms exceeded.
  155 |       response.request().method() === 'POST'
  156 |       && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
  157 |     ));
  158 |     const row = this.utilityRulesTab.exclusionRowContaining(text);
  159 |     await this.utilityRulesTab.revertButtonForRow(row).click();
  160 |     await this.utilityRulesTab.revertYes.click();
  161 |     await row.waitFor({ state: 'detached', timeout: 60000 });
  162 |     const response = await acknowledgement;
  163 |     if (!response.ok()) {
  164 |       throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
  165 |     }
  166 |   }
  167 | 
  168 |   async revertRuleByKey(rowKey) {
  169 |     const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
  170 |       response.request().method() === 'POST'
  171 |       && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
  172 |     ));
  173 |     const row = this.utilityRulesTab.exclusionRowByKey(rowKey);
  174 |     await this.utilityRulesTab.revertButtonForRow(row).click();
  175 |     await this.utilityRulesTab.revertYes.click();
  176 |     await row.waitFor({ state: 'detached', timeout: 60000 });
  177 |     const response = await acknowledgement;
  178 |     if (!response.ok()) {
  179 |       throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
  180 |     }
  181 |   }
  182 | 
  183 |   async beginRevertRuleContaining(text) {
  184 |     const requestStarted = this.utilityRulesTab.page.waitForRequest((request) => (
  185 |       request.method() === 'POST'
  186 |       && new URL(request.url()).pathname === '/utilities/rules/problem-ignores/revert'
  187 |     ));
  188 |     const acknowledgement = this.utilityRulesTab.page.waitForResponse((response) => (
  189 |       response.request().method() === 'POST'
  190 |       && new URL(response.url()).pathname === '/utilities/rules/problem-ignores/revert'
  191 |     ));
  192 |     let acknowledgementSettled = false;
  193 |     acknowledgement.then(
  194 |       () => { acknowledgementSettled = true; },
  195 |       () => { acknowledgementSettled = true; },
  196 |     );
  197 |     const row = this.utilityRulesTab.exclusionRowContaining(text);
  198 |     await this.utilityRulesTab.revertButtonForRow(row).click();
  199 |     await this.utilityRulesTab.revertYes.click();
  200 |     await row.waitFor({ state: 'detached', timeout: 60000 });
  201 |     await requestStarted;
  202 |     return {
  203 |       isAcknowledgementSettled: () => acknowledgementSettled,
  204 |       waitForAcknowledgement: async () => {
  205 |         const response = await acknowledgement;
  206 |         if (!response.ok()) {
  207 |           throw new Error(`Problem Exclusion revert returned HTTP ${response.status()}.`);
  208 |         }
  209 |       },
  210 |     };
  211 |   }
  212 | 
  213 |   async waitForPendingAlbumExclusion(text) {
  214 |     const row = this.utilityRulesTab.pendingExclusionRowContaining(text);
  215 |     await row.waitFor({ state: 'visible', timeout: 60000 });
  216 |     const revertButton = this.utilityRulesTab.revertButtonForRow(row);
  217 |     await revertButton.waitFor({ state: 'visible', timeout: 60000 });
  218 |     return {
  219 |       ariaBusy: await row.getAttribute('aria-busy'),
  220 |       revertDisabled: await revertButton.isDisabled(),
  221 |       text: String(await row.textContent() || '').trim(),
  222 |     };
  223 |   }
  224 | 
  225 |   async waitForExclusionAcknowledged(text) {
  226 |     const row = this.utilityRulesTab.exclusionRowContaining(text);
  227 |     await row.waitFor({ state: 'visible', timeout: 60000 });
  228 |     await this.utilityRulesTab.pendingExclusionRowContaining(text)
  229 |       .waitFor({ state: 'hidden', timeout: 60000 });
  230 |     await this.utilityRulesTab.revertButtonForRow(row).waitFor({ state: 'visible', timeout: 60000 });
  231 |     if (await this.utilityRulesTab.revertButtonForRow(row).isDisabled()) {
  232 |       throw new Error('Acknowledged Problem Exclusion row kept Revert rule disabled.');
  233 |     }
  234 |   }
  235 | }
  236 | 
```