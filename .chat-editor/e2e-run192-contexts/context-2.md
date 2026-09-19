# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: problematicFileNavigation.spec.js >> FTC-UTIL-PROBLEMS-001 scopes exclusions with optimistic persistence and reload
- Location: tests\e2e\specs\problematicFileNavigation.spec.js:185:1

# Error details

```
Test timeout of 240000ms exceeded.
```

```
Error: locator.click: Test timeout of 240000ms exceeded.
Call log:
  - waiting for locator('#utility-problematic-detail').getByRole('button', { name: 'Create Exception', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e1]:
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
                - generic "Album cover for Functional Fixture Album 332" [ref=e329]:
                  - img "Album cover for Functional Fixture Album 332" [ref=e330]
              - generic [ref=e331]:
                - heading "Functional Fixture Album 332" [level=3] [ref=e332]:
                  - button "Functional Fixture Album 332" [ref=e333] [cursor=pointer]
                - generic [ref=e335]: Agents Of Mercy · 2002
                - generic [ref=e336]:
                  - img "Album rating 6/10" [ref=e337]:
                    - generic [ref=e338]: ★
                    - generic [ref=e339]: ★
                    - generic [ref=e340]: ★
                    - generic [ref=e341]: ★
                    - generic [ref=e342]: ★
                    - generic [ref=e343]: ★
                    - generic [ref=e344]: ☆
                    - generic [ref=e345]: ☆
                    - generic [ref=e346]: ☆
                    - generic [ref=e347]: ☆
                  - generic [ref=e348]: 6/10
                - generic [ref=e349]:
                  - generic [ref=e350]: 18 tracks
                  - generic [ref=e351]: 18m 00s
        - generic [ref=e353]:
          - generic [ref=e354]:
            - heading "Album Haven Last.fm Fixture" [level=2] [ref=e355]
            - button "Information about Album Haven Last.fm Fixture" [ref=e356] [cursor=pointer]:
              - generic [ref=e357]: i
            - generic [ref=e359]: 1 album
          - generic [ref=e362]:
            - button "Open Signed Scrobble Journey tracklist" [ref=e363] [cursor=pointer]:
              - generic "Album cover for Signed Scrobble Journey" [ref=e364]
            - generic [ref=e365]:
              - heading "Signed Scrobble Journey" [level=3] [ref=e366]:
                - button "Signed Scrobble Journey" [ref=e367] [cursor=pointer]
              - generic [ref=e369]: Album Haven Last.fm Fixture · 2026
              - generic [ref=e370]:
                - img "Album rating 3/10" [ref=e371]:
                  - generic [ref=e372]: ★
                  - generic [ref=e373]: ★
                  - generic [ref=e374]: ★
                  - generic [ref=e375]: ☆
                  - generic [ref=e376]: ☆
                  - generic [ref=e377]: ☆
                  - generic [ref=e378]: ☆
                  - generic [ref=e379]: ☆
                  - generic [ref=e380]: ☆
                  - generic [ref=e381]: ☆
                - generic [ref=e382]: 3/10
              - generic [ref=e383]:
                - generic [ref=e384]: 18 tracks
                - generic [ref=e385]: 15m 48s
  - generic [ref=e388]:
    - generic [ref=e389]:
      - button "Collapse player" [ref=e390] [cursor=pointer]:
        - generic [ref=e391]: ‹
      - button "Open album details" [ref=e392] [cursor=pointer]
      - generic [ref=e393]:
        - button "Play" [disabled] [ref=e394] [cursor=pointer]: ▶
        - generic:
          - generic:
            - generic:
              - button "Create a loop" [disabled]
    - generic [ref=e397]:
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
  - dialog "Settings" [ref=e399]:
    - generic [ref=e400]:
      - tablist "Settings sections" [ref=e401]:
        - tab "Problematic files" [selected] [ref=e402] [cursor=pointer]
        - tab "Rules" [ref=e403] [cursor=pointer]
        - tab "Loops" [ref=e404] [cursor=pointer]
        - tab "Log History" [ref=e405] [cursor=pointer]
        - tab "Integrations" [ref=e406] [cursor=pointer]
        - tab "Appearance" [ref=e407] [cursor=pointer]
      - button "Close utilities" [ref=e408] [cursor=pointer]:
        - generic [ref=e409]: ✕
    - generic [ref=e410]:
      - complementary [ref=e411]:
        - generic [ref=e415]:
          - searchbox "Search settings items" [ref=e416]: "?"
          - button "Filters" [ref=e418] [cursor=pointer]
        - button "Artwork for ? ? Generated Problem Fixture · 2005" [ref=e420] [cursor=pointer]:
          - generic "Artwork for ?" [ref=e422]:
            - img "Artwork for ?" [ref=e423]
          - generic [ref=e424]:
            - generic [ref=e425]: "?"
            - generic [ref=e426]: Generated Problem Fixture · 2005
      - tabpanel "Problematic files" [ref=e427]:
        - generic [ref=e428]:
          - button "Enlarge Album cover for ?" [ref=e430]:
            - generic "Album cover for ?" [ref=e431]:
              - img "Album cover for ?" [ref=e432]
          - generic [ref=e433]:
            - heading "?" [level=3] [ref=e434]
            - generic [ref=e435]: Generated Problem Fixture
            - generic [ref=e436]: "Year: 2005"
            - generic [ref=e437]: "Tracks: 18"
            - generic [ref=e438]: "File types: MP3"
          - generic [ref=e439]:
            - button "Open In File Explorer" [ref=e440] [cursor=pointer]
            - button "Edit Tags" [ref=e443] [cursor=pointer]:
              - img [ref=e445]
            - button "Find on Discogs" [ref=e447] [cursor=pointer]:
              - img [ref=e449]
        - status
        - button "Undecoded characters (\"?\" in Album)" [active] [pressed] [ref=e452] [cursor=pointer]
        - heading "Detected problems" [level=4] [ref=e453]
        - paragraph [ref=e454]: Only album-level problems found. No per-track problems.
```

# Test source

```ts
  539 |       throw new Error('A strict Suggested Edits subset requires one selected row among at least two suggestions.');
  540 |     }
  541 |     for (const row of rows.filter(item => item.selected !== (item.rowKey === selectedRowKey))) {
  542 |       const rowLocator = this.utilityProblematicFilesTab.suggestedEditRowByKey(row.rowKey);
  543 |       await rowLocator.click();
  544 |     }
  545 |     const selected = await this.readSuggestedEditRows();
  546 |     if (selected.filter(row => row.selected).map(row => row.rowKey).join() !== selectedRowKey) {
  547 |       throw new Error('Suggested Edits did not retain the requested strict repair subset.');
  548 |     }
  549 |     await this.utilityProblematicFilesTab.suggestedEditsApplyButton.click();
  550 |     await this.utilityProblematicFilesTab.repairConfirmDialog.waitFor({ state: 'visible', timeout: 60000 });
  551 |     const acknowledgement = this.utilityProblematicFilesTab.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/utilities/edit-tags');
  552 |     await this.utilityProblematicFilesTab.repairConfirmAcceptButton.click();
  553 |     const response = await acknowledgement;
  554 |     assert.deepEqual(response.request().postDataJSON().proposal_ids, [selectedRowKey]);
  555 |     assert.equal(response.ok(), true);
  556 |     const outcome = await response.json();
  557 |     assert.equal(outcome.ok, true);
  558 |     assert.deepEqual(outcome.proposal_outcomes.map(item => ({ id: item.id, status: item.status })), [{ id: selectedRowKey, status: 'committed' }]);
  559 |     await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
  560 |     await this.utilityProblematicFilesTab.waitForPageCondition((selectors) => (
  561 |       !document.querySelector(selectors.overlay)
  562 |       && document.querySelector(selectors.detail)
  563 |     ), { timeout: 90000 }, {
  564 |       overlay: this.utilityProblematicFilesTab.mutationOverlaySelector,
  565 |       detail: this.utilityProblematicFilesTab.detailTitleSelector,
  566 |     });
  567 |   }
  568 | 
  569 |   async dragFileProblemRange(filenames, reason) {
  570 |     const pills = filenames.map((filename) => this.utilityProblematicFilesTab.fileProblemPill(filename, reason));
  571 |     const boxes = [];
  572 |     for (const pill of pills) {
  573 |       await pill.waitFor({ state: 'visible', timeout: 60000 });
  574 |       boxes.push(await pill.boundingBox());
  575 |     }
  576 |     if (boxes.some((box) => !box)) throw new Error('Expected every Problematic reason pill to have pointer geometry.');
  577 |     const center = (box) => ({ x: box.x + (box.width / 2), y: box.y + (box.height / 2) });
  578 |     const start = center(boxes[0]);
  579 |     await this.utilityProblematicFilesTab.page.mouse.move(start.x, start.y);
  580 |     await this.utilityProblematicFilesTab.page.mouse.down();
  581 |     for (const box of boxes.slice(1)) {
  582 |       const point = center(box);
  583 |       await this.utilityProblematicFilesTab.page.mouse.move(point.x, point.y, { steps: 4 });
  584 |     }
  585 |     await this.utilityProblematicFilesTab.page.mouse.up();
  586 |   }
  587 | 
  588 |   async dragBetweenProblemPills(start, end) {
  589 |     const pills = [
  590 |       this.utilityProblematicFilesTab.fileProblemPill(start.filename, start.reason),
  591 |       this.utilityProblematicFilesTab.fileProblemPill(end.filename, end.reason),
  592 |     ];
  593 |     const boxes = [];
  594 |     for (const pill of pills) {
  595 |       await pill.waitFor({ state: 'visible', timeout: 60000 });
  596 |       boxes.push(await pill.boundingBox());
  597 |     }
  598 |     if (boxes.some((box) => !box)) throw new Error('Expected both boundary pills to have pointer geometry.');
  599 |     const center = (box) => ({ x: box.x + (box.width / 2), y: box.y + (box.height / 2) });
  600 |     const startPoint = center(boxes[0]);
  601 |     const endPoint = center(boxes[1]);
  602 |     await this.utilityProblematicFilesTab.page.mouse.move(startPoint.x, startPoint.y);
  603 |     await this.utilityProblematicFilesTab.page.mouse.down();
  604 |     await this.utilityProblematicFilesTab.page.mouse.move(endPoint.x, endPoint.y, { steps: 8 });
  605 |     await this.utilityProblematicFilesTab.page.mouse.up();
  606 |   }
  607 | 
  608 |   async readSelectedProblemInstances() {
  609 |     // parity-check: allow-read-only-measurement-evaluate -- capture selected problem identities atomically
  610 |     return this.utilityProblematicFilesTab.selectedProblemPills.evaluateAll((elements) => elements.map((element) => ({
  611 |       scope: element.getAttribute('data-problem-exclusion-scope'),
  612 |       ...(element.hasAttribute('data-album-problem-type')
  613 |         ? { scope: 'album', problemType: element.getAttribute('data-album-problem-type') }
  614 |         : { key: element.getAttribute('data-problem-exclusion-row-key') }),
  615 |       reason: String(element.textContent || '').trim(),
  616 |       canonicalReason: element.getAttribute('data-problem-exclusion-reason'),
  617 |     })));
  618 |   }
  619 | 
  620 |   async openExclusionConfirmation() {
  621 |     const selected = await this.readSelectedProblemInstances();
  622 |     assert.ok(selected.length > 0, 'Exclusion confirmation requires selected real problem labels.');
  623 |     const albumKey = await this.utilityProblematicFilesTab.activeListItem.getAttribute('data-problematic-album-key');
  624 |     const response = await authenticatedPageGet(this.utilityProblematicFilesTab.page, `/utilities/problematic-files/detail?album_key=${encodeURIComponent(albumKey)}`);
  625 |     assert.equal(response.ok(), true);
  626 |     const album = await response.json();
  627 |     assert.equal(album.key, albumKey);
  628 |     const chosenKeys = new Set(selected.filter(item => item.scope === 'file').map(item => item.key));
  629 |     const albumReasons = new Set(selected.filter(item => item.scope === 'album').map(item => item.canonicalReason));
  630 |     const albumRows = (album.album_problem_rows || []).filter(item => chosenKeys.has(item.row_key) || albumReasons.has(item.reason));
  631 |     const fileRows = (album.track_problem_rows || []).flatMap(row => (row.ignorable_reasons || [])
  632 |       .filter(item => chosenKeys.has(item.row_key) || albumReasons.has(item.reason))
  633 |       .map(item => ({ ...item, path: row.path, filename: row.filename })));
  634 |     this.expectedExclusionItems = [...albumRows.map(item => ({ row_key: item.row_key, scope: 'album', album_key: item.album_key || albumKey })),
  635 |       ...fileRows.map(item => ({ row_key: item.row_key, scope: 'file', path: item.path }))];
  636 |     assert.ok(this.expectedExclusionItems.length > 0);
  637 |     const targets = [...albumRows.map(item => `${album.name || 'Album'} — ${item.display_reason || item.reason}`),
  638 |       ...fileRows.map(item => `${item.filename || item.path.split(/[\\/]/).pop()} — ${item.reason}`)];
> 639 |     await this.utilityProblematicFilesTab.excludeProblemButton.click();
      |                                                                ^ Error: locator.click: Test timeout of 240000ms exceeded.
  640 |     await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.exclusionConfirmDialog);
  641 |     const text = String(await this.utilityProblematicFilesTab.exclusionConfirmText.textContent() || '').trim();
  642 |     assert.equal(text, `Create an exclusion rule for ${targets.join('; ')}? These problems will be hidden. You can revert this rule in Rules.`);
  643 |     return text;
  644 |   }
  645 | 
  646 |   async clearSelectedProblems() {
  647 |     const labels = this.utilityProblematicFilesTab.selectedProblemPills;
  648 |     const initialCount = await labels.count();
  649 |     for (let index = 0; index < initialCount && await labels.count(); index += 1) await labels.first().click();
  650 |     assert.equal(await labels.count(), 0);
  651 |   }
  652 | 
  653 |   verifyExclusionRequest(request) {
  654 |     const sort = items => [...items].sort((a, b) => a.row_key.localeCompare(b.row_key));
  655 |     assert.deepEqual(sort(request.postDataJSON().items), sort(this.expectedExclusionItems));
  656 |   }
  657 | 
  658 |   async cancelExclusion() {
  659 |     await this.utilityProblematicFilesTab.exclusionCancelButton.click();
  660 |     await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
  661 |   }
  662 | 
  663 |   async confirmExclusion() {
  664 |     const acknowledgement = this.utilityProblematicFilesTab.page.waitForResponse((response) => (
  665 |       response.request().method() === 'POST'
  666 |       && new URL(response.url()).pathname === '/utilities/rules/problem-ignores'
  667 |     ));
  668 |     await this.utilityProblematicFilesTab.exclusionAcceptButton.click();
  669 |     await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
  670 |     await this.utilityProblematicFilesTab.waitForPageCondition((selectors) => (
  671 |       !document.querySelector(selectors.overlay)
  672 |       && (
  673 |         document.querySelector(selectors.detail)
  674 |         || document.querySelector(selectors.empty)
  675 |       )
  676 |     ), { timeout: 90000 }, {
  677 |       overlay: this.utilityProblematicFilesTab.mutationOverlaySelector,
  678 |       detail: this.utilityProblematicFilesTab.detailTitleSelector,
  679 |       empty: this.utilityProblematicFilesTab.listEmptyStateSelector,
  680 |     });
  681 |     const response = await acknowledgement;
  682 |     this.verifyExclusionRequest(response.request());
  683 |     if (!response.ok()) {
  684 |       throw new Error(`Problem Exclusion creation returned HTTP ${response.status()}.`);
  685 |     }
  686 |   }
  687 | 
  688 |   async beginConfirmExclusion() {
  689 |     const requestStarted = this.utilityProblematicFilesTab.page.waitForRequest((request) => (
  690 |       request.method() === 'POST'
  691 |       && new URL(request.url()).pathname === '/utilities/rules/problem-ignores'
  692 |     ));
  693 |     const acknowledgement = this.utilityProblematicFilesTab.page.waitForResponse((response) => (
  694 |       response.request().method() === 'POST'
  695 |       && new URL(response.url()).pathname === '/utilities/rules/problem-ignores'
  696 |     ));
  697 |     let acknowledgementSettled = false;
  698 |     acknowledgement.then(
  699 |       () => { acknowledgementSettled = true; },
  700 |       () => { acknowledgementSettled = true; },
  701 |     );
  702 |     await this.utilityProblematicFilesTab.exclusionAcceptButton.click();
  703 |     await this.utilityProblematicFilesTab.exclusionConfirmDialog.waitFor({ state: 'hidden', timeout: 60000 });
  704 |     this.verifyExclusionRequest(await requestStarted);
  705 |     return {
  706 |       isAcknowledgementSettled: () => acknowledgementSettled,
  707 |       waitForAcknowledgement: async () => {
  708 |         const response = await acknowledgement;
  709 |         if (!response.ok()) {
  710 |           throw new Error(`Problem Exclusion creation returned HTTP ${response.status()}.`);
  711 |         }
  712 |       },
  713 |     };
  714 |   }
  715 | 
  716 |   async waitForOptimisticAlbumRemoval(albumTitle) {
  717 |     await this.utilityProblematicFilesTab.listItemByTitle(albumTitle)
  718 |       .waitFor({ state: 'detached', timeout: 60000 });
  719 |   }
  720 | 
  721 |   async readRepairProgressOverlayVisible() {
  722 |     return this.utilityProblematicFilesTab.repairProgressOverlay.isVisible();
  723 |   }
  724 | 
  725 |   async readTagRepairErrorToastCount() {
  726 |     return this.utilityProblematicFilesTab.errorToasts.filter({
  727 |       hasText: 'Failed to repair local tags',
  728 |     }).count();
  729 |   }
  730 | 
  731 |   async prepareSelectedMutationContinuity() {
  732 |     await this.utilityProblematicFilesTab.activeListItem.scrollIntoViewIfNeeded();
  733 |     this.mutationObservation = await this.utilityProblematicFilesTab.page.evaluateHandle((selectors) => {
  734 |       const list = document.querySelector(selectors.listSelector);
  735 |       const active = document.querySelector(selectors.activeSelector);
  736 |       const items = Array.from(document.querySelectorAll(selectors.itemSelector));
  737 |       const removedIndex = items.indexOf(active);
  738 |       if (!(list instanceof HTMLElement) || removedIndex <= 0) {
  739 |         throw new Error('Mutation continuity requires a selected Problematic row with a previous survivor.');
```