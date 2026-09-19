# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: problematicFileNavigation.spec.js >> FTC-UTIL-PROBLEMS-011 opens the exact problematic track from album details
- Location: tests\e2e\specs\problematicFileNavigation.spec.js:81:1

# Error details

```
TimeoutError: page.waitForFunction: Timeout 60000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "Album Haven library" [ref=e4] [cursor=pointer]:
        - /url: /
      - generic [ref=e10]:
        - combobox "Search music" [ref=e11]: Neal Morse Plays Pink Floyd
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
        - link "Morse Portnoy George 2" [ref=e35] [cursor=pointer]:
          - /url: /?surface=albums&q=Neal+Morse+Plays+Pink+Floyd&artist=Morse+Portnoy+George&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard
          - generic [ref=e36]: Morse Portnoy George
          - generic [ref=e37]: "2"
        - link "Neal Morse 1" [ref=e38] [cursor=pointer]:
          - /url: /?surface=albums&q=Neal+Morse+Plays+Pink+Floyd&artist=Neal+Morse&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard
          - generic [ref=e39]: Neal Morse
          - generic [ref=e40]: "1"
        - link "Neal Morse & The Resonance 10" [ref=e41] [cursor=pointer]:
          - /url: /?surface=albums&q=Neal+Morse+Plays+Pink+Floyd&artist=Neal+Morse+%26+The+Resonance&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard
          - generic [ref=e42]: Neal Morse & The Resonance
          - generic [ref=e43]: "10"
        - link "The Neal Morse Band 10" [ref=e44] [cursor=pointer]:
          - /url: /?surface=albums&q=Neal+Morse+Plays+Pink+Floyd&artist=The+Neal+Morse+Band&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard
          - generic [ref=e45]: The Neal Morse Band
          - generic [ref=e46]: "10"
        - link "Transatlantic 18" [ref=e47] [cursor=pointer]:
          - /url: /?surface=albums&q=Neal+Morse+Plays+Pink+Floyd&artist=Transatlantic&gallery_scope=all&category=main_library&category=new_arrivals&category=hoard
          - generic [ref=e48]: Transatlantic
          - generic [ref=e49]: "18"
    - main [ref=e50]:
      - region "Gallery controls" [ref=e51]:
        - generic [ref=e52]:
          - generic [ref=e54]: Neal Morse family
          - generic [ref=e55]: 5 artists · 41 albums
        - generic [ref=e56]:
          - button "Artist Family" [ref=e57] [cursor=pointer]:
            - img [ref=e58]
          - group "Gallery view" [ref=e62]:
            - button "Cards" [pressed] [ref=e63] [cursor=pointer]:
              - img [ref=e64]
          - button "Album types" [ref=e67] [cursor=pointer]:
            - img [ref=e68]
      - generic [ref=e74]:
        - generic [ref=e75]:
          - generic [ref=e76]:
            - heading "Neal Morse" [level=2] [ref=e77]
            - button "Information about Neal Morse" [ref=e78] [cursor=pointer]:
              - generic [ref=e79]: i
            - generic [ref=e81]: 1 album
          - generic [ref=e84]:
            - button "Open Neal Morse Plays Pink Floyd tracklist" [ref=e85] [cursor=pointer]:
              - generic "Album cover for Neal Morse Plays Pink Floyd" [ref=e86]:
                - img [ref=e88]
            - generic [ref=e95]:
              - heading "Neal Morse Plays Pink Floyd" [level=3] [ref=e96]:
                - button "Neal Morse Plays Pink Floyd" [ref=e97] [cursor=pointer]
              - generic [ref=e99]: Neal Morse · 2023
              - generic [ref=e100]:
                - img "Album rating 3/10" [ref=e101]:
                  - generic [ref=e102]: ★
                  - generic [ref=e103]: ★
                  - generic [ref=e104]: ★
                  - generic [ref=e105]: ☆
                  - generic [ref=e106]: ☆
                  - generic [ref=e107]: ☆
                  - generic [ref=e108]: ☆
                  - generic [ref=e109]: ☆
                  - generic [ref=e110]: ☆
                  - generic [ref=e111]: ☆
                - generic [ref=e112]: 3/10
              - generic [ref=e113]:
                - generic [ref=e114]: 18 tracks
                - generic [ref=e115]: 1m 12s
        - generic [ref=e116]:
          - generic [ref=e117]: Family
          - generic [ref=e119]: 40 albums
        - generic [ref=e120]:
          - generic [ref=e121]:
            - heading "Transatlantic" [level=2] [ref=e122]
            - button "Information about Transatlantic" [ref=e123] [cursor=pointer]:
              - generic [ref=e124]: i
            - generic [ref=e126]: 18 albums
          - generic [ref=e127]:
            - generic [ref=e128]:
              - generic [ref=e129]:
                - button "Open Functional Fixture Album 175 tracklist" [ref=e130] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 175" [ref=e131]:
                    - img "Album cover for Functional Fixture Album 175" [ref=e132]
                - generic [ref=e133]:
                  - heading "Functional Fixture Album 175" [level=3] [ref=e134]:
                    - button "Functional Fixture Album 175" [ref=e135] [cursor=pointer]
                  - generic [ref=e137]: "1995"
                  - generic [ref=e138]:
                    - img "Album rating 9/10" [ref=e139]:
                      - generic [ref=e140]: ★
                      - generic [ref=e141]: ★
                      - generic [ref=e142]: ★
                      - generic [ref=e143]: ★
                      - generic [ref=e144]: ★
                      - generic [ref=e145]: ★
                      - generic [ref=e146]: ★
                      - generic [ref=e147]: ★
                      - generic [ref=e148]: ★
                      - generic [ref=e149]: ☆
                    - generic [ref=e150]: 9/10
                  - generic [ref=e151]:
                    - generic [ref=e152]: 18 tracks
                    - generic [ref=e153]: 18m 00s
              - generic [ref=e154]:
                - button "Open Functional Fixture Album 176 tracklist" [ref=e155] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 176" [ref=e156]:
                    - img "Album cover for Functional Fixture Album 176" [ref=e157]
                - generic [ref=e158]:
                  - heading "Functional Fixture Album 176" [level=3] [ref=e159]:
                    - button "Functional Fixture Album 176" [ref=e160] [cursor=pointer]
                  - generic [ref=e162]: "1996"
                  - generic [ref=e163]:
                    - img "Album rating 10/10" [ref=e164]:
                      - generic [ref=e165]: ★
                      - generic [ref=e166]: ★
                      - generic [ref=e167]: ★
                      - generic [ref=e168]: ★
                      - generic [ref=e169]: ★
                      - generic [ref=e170]: ★
                      - generic [ref=e171]: ★
                      - generic [ref=e172]: ★
                      - generic [ref=e173]: ★
                      - generic [ref=e174]: ★
                    - generic [ref=e175]: 10/10
                  - generic [ref=e176]:
                    - generic [ref=e177]: 18 tracks
                    - generic [ref=e178]: 18m 00s
              - generic [ref=e179]:
                - button "Open Functional Fixture Album 177 tracklist" [ref=e180] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 177" [ref=e181]:
                    - img "Album cover for Functional Fixture Album 177" [ref=e182]
                - generic [ref=e183]:
                  - heading "Functional Fixture Album 177" [level=3] [ref=e184]:
                    - button "Functional Fixture Album 177" [ref=e185] [cursor=pointer]
                  - generic [ref=e187]: "1997"
                  - generic [ref=e188]:
                    - img "Album rating 1/10" [ref=e189]:
                      - generic [ref=e190]: ★
                      - generic [ref=e191]: ☆
                      - generic [ref=e192]: ☆
                      - generic [ref=e193]: ☆
                      - generic [ref=e194]: ☆
                      - generic [ref=e195]: ☆
                      - generic [ref=e196]: ☆
                      - generic [ref=e197]: ☆
                      - generic [ref=e198]: ☆
                      - generic [ref=e199]: ☆
                    - generic [ref=e200]: 1/10
                  - generic [ref=e201]:
                    - generic [ref=e202]: 18 tracks
                    - generic [ref=e203]: 18m 00s
              - generic [ref=e204]:
                - button "Open Functional Fixture Album 178 tracklist" [ref=e205] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 178" [ref=e206]:
                    - img "Album cover for Functional Fixture Album 178" [ref=e207]
                - generic [ref=e208]:
                  - heading "Functional Fixture Album 178" [level=3] [ref=e209]:
                    - button "Functional Fixture Album 178" [ref=e210] [cursor=pointer]
                  - generic [ref=e212]: "1998"
                  - generic [ref=e213]:
                    - img "Album rating 2/10" [ref=e214]:
                      - generic [ref=e215]: ★
                      - generic [ref=e216]: ★
                      - generic [ref=e217]: ☆
                      - generic [ref=e218]: ☆
                      - generic [ref=e219]: ☆
                      - generic [ref=e220]: ☆
                      - generic [ref=e221]: ☆
                      - generic [ref=e222]: ☆
                      - generic [ref=e223]: ☆
                      - generic [ref=e224]: ☆
                    - generic [ref=e225]: 2/10
                  - generic [ref=e226]:
                    - generic [ref=e227]: 18 tracks
                    - generic [ref=e228]: 18m 00s
            - generic [ref=e229]:
              - generic [ref=e230]:
                - button "Open Functional Fixture Album 179 tracklist" [ref=e231] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 179" [ref=e232]:
                    - img "Album cover for Functional Fixture Album 179" [ref=e233]
                - generic [ref=e234]:
                  - heading "Functional Fixture Album 179" [level=3] [ref=e235]:
                    - button "Functional Fixture Album 179" [ref=e236] [cursor=pointer]
                  - generic [ref=e238]: "1999"
                  - generic [ref=e239]:
                    - img "Album rating 3/10" [ref=e240]:
                      - generic [ref=e241]: ★
                      - generic [ref=e242]: ★
                      - generic [ref=e243]: ★
                      - generic [ref=e244]: ☆
                      - generic [ref=e245]: ☆
                      - generic [ref=e246]: ☆
                      - generic [ref=e247]: ☆
                      - generic [ref=e248]: ☆
                      - generic [ref=e249]: ☆
                      - generic [ref=e250]: ☆
                    - generic [ref=e251]: 3/10
                  - generic [ref=e252]:
                    - generic [ref=e253]: 18 tracks
                    - generic [ref=e254]: 18m 00s
              - generic [ref=e255]:
                - button "Open Functional Fixture Album 180 tracklist" [ref=e256] [cursor=pointer]:
                  - generic "Album cover for Functional Fixture Album 180" [ref=e257]
                - generic [ref=e258]:
                  - heading "Functional Fixture Album 180" [level=3] [ref=e259]:
                    - button "Functional Fixture Album 180" [ref=e260] [cursor=pointer]
                  - generic [ref=e262]: "2000"
                  - generic [ref=e263]:
                    - img "Album rating 4/10" [ref=e264]:
                      - generic [ref=e265]: ★
                      - generic [ref=e266]: ★
                      - generic [ref=e267]: ★
                      - generic [ref=e268]: ★
                      - generic [ref=e269]: ☆
                      - generic [ref=e270]: ☆
                      - generic [ref=e271]: ☆
                      - generic [ref=e272]: ☆
                      - generic [ref=e273]: ☆
                      - generic [ref=e274]: ☆
                    - generic [ref=e275]: 4/10
                  - generic [ref=e276]:
                    - generic [ref=e277]: 18 tracks
                    - generic [ref=e278]: 18m 00s
              - generic [ref=e279]:
                - button "Open SMPT:e tracklist" [ref=e280] [cursor=pointer]:
                  - generic "Album cover for SMPT:e" [ref=e281]
                - generic [ref=e282]:
                  - heading "SMPT:e" [level=3] [ref=e283]:
                    - button "SMPT:e" [ref=e284] [cursor=pointer]
                  - generic [ref=e286]: "2000"
                  - generic [ref=e287]:
                    - img "Album rating 5/10" [ref=e288]:
                      - generic [ref=e289]: ★
                      - generic [ref=e290]: ★
                      - generic [ref=e291]: ★
                      - generic [ref=e292]: ★
                      - generic [ref=e293]: ★
                      - generic [ref=e294]: ☆
                      - generic [ref=e295]: ☆
                      - generic [ref=e296]: ☆
                      - generic [ref=e297]: ☆
                      - generic [ref=e298]: ☆
                    - generic [ref=e299]: 5/10
                  - generic [ref=e300]:
                    - generic [ref=e301]: 18 tracks
                    - generic [ref=e302]: 1m 12s
              - generic [ref=e303]:
                - button "Open Bridge Across Forever tracklist" [ref=e304] [cursor=pointer]:
                  - generic "Album cover for Bridge Across Forever" [ref=e305]:
                    - img "Album cover for Bridge Across Forever" [ref=e306]
                - generic [ref=e307]:
                  - heading "Bridge Across Forever" [level=3] [ref=e308]:
                    - button "Bridge Across Forever" [ref=e309] [cursor=pointer]
                  - generic [ref=e311]: "2001"
                  - generic [ref=e312]:
                    - img "Album rating 6/10" [ref=e313]:
                      - generic [ref=e314]: ★
                      - generic [ref=e315]: ★
                      - generic [ref=e316]: ★
                      - generic [ref=e317]: ★
                      - generic [ref=e318]: ★
                      - generic [ref=e319]: ★
                      - generic [ref=e320]: ☆
                      - generic [ref=e321]: ☆
                      - generic [ref=e322]: ☆
                      - generic [ref=e323]: ☆
                    - generic [ref=e324]: 6/10
                  - generic [ref=e325]:
                    - generic [ref=e326]: 18 tracks
                    - generic [ref=e327]: 1m 12s
        - generic [ref=e329]:
          - generic [ref=e330]:
            - heading "Neal Morse & The Resonance" [level=2] [ref=e331]
            - button "Information about Neal Morse & The Resonance" [ref=e332] [cursor=pointer]:
              - generic [ref=e333]: i
            - generic [ref=e335]: 10 albums
          - generic [ref=e337]:
            - generic [ref=e338]:
              - button "Open Functional Fixture Album 302 tracklist" [ref=e339] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 302" [ref=e340]
              - generic [ref=e341]:
                - heading "Functional Fixture Album 302" [level=3] [ref=e342]:
                  - button "Functional Fixture Album 302" [ref=e343] [cursor=pointer]
                - generic [ref=e345]: "1997"
                - generic [ref=e346]:
                  - img "Album rating 6/10" [ref=e347]:
                    - generic [ref=e348]: ★
                    - generic [ref=e349]: ★
                    - generic [ref=e350]: ★
                    - generic [ref=e351]: ★
                    - generic [ref=e352]: ★
                    - generic [ref=e353]: ★
                    - generic [ref=e354]: ☆
                    - generic [ref=e355]: ☆
                    - generic [ref=e356]: ☆
                    - generic [ref=e357]: ☆
                  - generic [ref=e358]: 6/10
                - generic [ref=e359]:
                  - generic [ref=e360]: 18 tracks
                  - generic [ref=e361]: 18m 00s
            - generic [ref=e362]:
              - button "Open Functional Fixture Album 303 tracklist" [ref=e363] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 303" [ref=e364]
              - generic [ref=e365]:
                - heading "Functional Fixture Album 303" [level=3] [ref=e366]:
                  - button "Functional Fixture Album 303" [ref=e367] [cursor=pointer]
                - generic [ref=e369]: "1998"
                - generic [ref=e370]:
                  - img "Album rating 7/10" [ref=e371]:
                    - generic [ref=e372]: ★
                    - generic [ref=e373]: ★
                    - generic [ref=e374]: ★
                    - generic [ref=e375]: ★
                    - generic [ref=e376]: ★
                    - generic [ref=e377]: ★
                    - generic [ref=e378]: ★
                    - generic [ref=e379]: ☆
                    - generic [ref=e380]: ☆
                    - generic [ref=e381]: ☆
                  - generic [ref=e382]: 7/10
                - generic [ref=e383]:
                  - generic [ref=e384]: 18 tracks
                  - generic [ref=e385]: 18m 00s
            - generic [ref=e386]:
              - button "Open Functional Fixture Album 304 tracklist" [ref=e387] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 304" [ref=e388]
              - generic [ref=e389]:
                - heading "Functional Fixture Album 304" [level=3] [ref=e390]:
                  - button "Functional Fixture Album 304" [ref=e391] [cursor=pointer]
                - generic [ref=e393]: "1999"
                - generic [ref=e394]:
                  - img "Album rating 8/10" [ref=e395]:
                    - generic [ref=e396]: ★
                    - generic [ref=e397]: ★
                    - generic [ref=e398]: ★
                    - generic [ref=e399]: ★
                    - generic [ref=e400]: ★
                    - generic [ref=e401]: ★
                    - generic [ref=e402]: ★
                    - generic [ref=e403]: ★
                    - generic [ref=e404]: ☆
                    - generic [ref=e405]: ☆
                  - generic [ref=e406]: 8/10
                - generic [ref=e407]:
                  - generic [ref=e408]: 18 tracks
                  - generic [ref=e409]: 18m 00s
            - generic [ref=e410]:
              - button "Open Functional Fixture Album 305 tracklist" [ref=e411] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 305" [ref=e412]
              - generic [ref=e413]:
                - heading "Functional Fixture Album 305" [level=3] [ref=e414]:
                  - button "Functional Fixture Album 305" [ref=e415] [cursor=pointer]
                - generic [ref=e417]: "2000"
                - generic [ref=e418]:
                  - img "Album rating 9/10" [ref=e419]:
                    - generic [ref=e420]: ★
                    - generic [ref=e421]: ★
                    - generic [ref=e422]: ★
                    - generic [ref=e423]: ★
                    - generic [ref=e424]: ★
                    - generic [ref=e425]: ★
                    - generic [ref=e426]: ★
                    - generic [ref=e427]: ★
                    - generic [ref=e428]: ★
                    - generic [ref=e429]: ☆
                  - generic [ref=e430]: 9/10
                - generic [ref=e431]:
                  - generic [ref=e432]: 18 tracks
                  - generic [ref=e433]: 18m 00s
        - generic [ref=e435]:
          - generic [ref=e436]:
            - heading "Morse Portnoy George" [level=2] [ref=e437]
            - button "Information about Morse Portnoy George" [ref=e438] [cursor=pointer]:
              - generic [ref=e439]: i
            - generic [ref=e441]: 2 albums
          - generic [ref=e443]:
            - generic [ref=e444]:
              - button "Open Cover to Cover tracklist" [ref=e445] [cursor=pointer]:
                - generic "Album cover for Cover to Cover" [ref=e446]
              - generic [ref=e447]:
                - heading "Cover to Cover" [level=3] [ref=e448]:
                  - button "Cover to Cover" [ref=e449] [cursor=pointer]
                - generic [ref=e451]: "2006"
                - generic [ref=e452]:
                  - img "Album rating 10/10" [ref=e453]:
                    - generic [ref=e454]: ★
                    - generic [ref=e455]: ★
                    - generic [ref=e456]: ★
                    - generic [ref=e457]: ★
                    - generic [ref=e458]: ★
                    - generic [ref=e459]: ★
                    - generic [ref=e460]: ★
                    - generic [ref=e461]: ★
                    - generic [ref=e462]: ★
                    - generic [ref=e463]: ★
                  - generic [ref=e464]: 10/10
                - generic [ref=e465]:
                  - generic [ref=e466]: 18 tracks
                  - generic [ref=e467]: 18m 00s
            - generic [ref=e468]:
              - button "Open Cover 2 Cover tracklist" [ref=e469] [cursor=pointer]:
                - generic "Album cover for Cover 2 Cover" [ref=e470]
              - generic [ref=e471]:
                - heading "Cover 2 Cover" [level=3] [ref=e472]:
                  - button "Cover 2 Cover" [ref=e473] [cursor=pointer]
                - generic [ref=e475]: Morse, Portnoy & George · 2012
                - generic [ref=e476]:
                  - img "Album rating 1/10" [ref=e477]:
                    - generic [ref=e478]: ★
                    - generic [ref=e479]: ☆
                    - generic [ref=e480]: ☆
                    - generic [ref=e481]: ☆
                    - generic [ref=e482]: ☆
                    - generic [ref=e483]: ☆
                    - generic [ref=e484]: ☆
                    - generic [ref=e485]: ☆
                    - generic [ref=e486]: ☆
                    - generic [ref=e487]: ☆
                  - generic [ref=e488]: 1/10
                - generic [ref=e489]:
                  - generic [ref=e490]: 18 tracks
                  - generic [ref=e491]: 18m 00s
        - generic [ref=e492]:
          - generic [ref=e493]:
            - heading "The Neal Morse Band" [level=2] [ref=e494]
            - button "Information about The Neal Morse Band" [ref=e495] [cursor=pointer]:
              - generic [ref=e496]: i
            - generic [ref=e498]: 10 albums
          - generic [ref=e500]:
            - generic [ref=e501]:
              - button "Open Functional Fixture Album 311 tracklist" [ref=e502] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 311" [ref=e503]
              - generic [ref=e504]:
                - heading "Functional Fixture Album 311" [level=3] [ref=e505]:
                  - button "Functional Fixture Album 311" [ref=e506] [cursor=pointer]
                - generic [ref=e508]: "2006"
                - generic [ref=e509]:
                  - img "Album rating 5/10" [ref=e510]:
                    - generic [ref=e511]: ★
                    - generic [ref=e512]: ★
                    - generic [ref=e513]: ★
                    - generic [ref=e514]: ★
                    - generic [ref=e515]: ★
                    - generic [ref=e516]: ☆
                    - generic [ref=e517]: ☆
                    - generic [ref=e518]: ☆
                    - generic [ref=e519]: ☆
                    - generic [ref=e520]: ☆
                  - generic [ref=e521]: 5/10
                - generic [ref=e522]:
                  - generic [ref=e523]: 18 tracks
                  - generic [ref=e524]: 18m 00s
            - generic [ref=e525]:
              - button "Open Functional Fixture Album 312 tracklist" [ref=e526] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 312" [ref=e527]
              - generic [ref=e528]:
                - heading "Functional Fixture Album 312" [level=3] [ref=e529]:
                  - button "Functional Fixture Album 312" [ref=e530] [cursor=pointer]
                - generic [ref=e532]: "2007"
                - generic [ref=e533]:
                  - img "Album rating 6/10" [ref=e534]:
                    - generic [ref=e535]: ★
                    - generic [ref=e536]: ★
                    - generic [ref=e537]: ★
                    - generic [ref=e538]: ★
                    - generic [ref=e539]: ★
                    - generic [ref=e540]: ★
                    - generic [ref=e541]: ☆
                    - generic [ref=e542]: ☆
                    - generic [ref=e543]: ☆
                    - generic [ref=e544]: ☆
                  - generic [ref=e545]: 6/10
                - generic [ref=e546]:
                  - generic [ref=e547]: 18 tracks
                  - generic [ref=e548]: 18m 00s
            - generic [ref=e549]:
              - button "Open Functional Fixture Album 313 tracklist" [ref=e550] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 313" [ref=e551]
              - generic [ref=e552]:
                - heading "Functional Fixture Album 313" [level=3] [ref=e553]:
                  - button "Functional Fixture Album 313" [ref=e554] [cursor=pointer]
                - generic [ref=e556]: "2008"
                - generic [ref=e557]:
                  - img "Album rating 7/10" [ref=e558]:
                    - generic [ref=e559]: ★
                    - generic [ref=e560]: ★
                    - generic [ref=e561]: ★
                    - generic [ref=e562]: ★
                    - generic [ref=e563]: ★
                    - generic [ref=e564]: ★
                    - generic [ref=e565]: ★
                    - generic [ref=e566]: ☆
                    - generic [ref=e567]: ☆
                    - generic [ref=e568]: ☆
                  - generic [ref=e569]: 7/10
                - generic [ref=e570]:
                  - generic [ref=e571]: 18 tracks
                  - generic [ref=e572]: 18m 00s
            - generic [ref=e573]:
              - button "Open Functional Fixture Album 314 tracklist" [ref=e574] [cursor=pointer]:
                - generic "Album cover for Functional Fixture Album 314" [ref=e575]
              - generic [ref=e576]:
                - heading "Functional Fixture Album 314" [level=3] [ref=e577]:
                  - button "Functional Fixture Album 314" [ref=e578] [cursor=pointer]
                - generic [ref=e580]: "2009"
                - generic [ref=e581]:
                  - img "Album rating 8/10" [ref=e582]:
                    - generic [ref=e583]: ★
                    - generic [ref=e584]: ★
                    - generic [ref=e585]: ★
                    - generic [ref=e586]: ★
                    - generic [ref=e587]: ★
                    - generic [ref=e588]: ★
                    - generic [ref=e589]: ★
                    - generic [ref=e590]: ★
                    - generic [ref=e591]: ☆
                    - generic [ref=e592]: ☆
                  - generic [ref=e593]: 8/10
                - generic [ref=e594]:
                  - generic [ref=e595]: 18 tracks
                  - generic [ref=e596]: 18m 00s
  - generic [ref=e599]:
    - generic [ref=e600]:
      - button "Collapse player" [ref=e601] [cursor=pointer]:
        - generic [ref=e602]: ‹
      - button "Open album details" [ref=e603] [cursor=pointer]
      - generic [ref=e604]:
        - button "Play" [disabled] [ref=e605] [cursor=pointer]: ▶
        - generic:
          - generic:
            - generic:
              - button "Create a loop" [disabled]
    - generic [ref=e608]:
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
  - dialog "Settings" [ref=e610]:
    - generic [ref=e611]:
      - tablist "Settings sections" [ref=e612]:
        - tab "Problematic files" [selected] [ref=e613] [cursor=pointer]
        - tab "Rules" [ref=e614] [cursor=pointer]
        - tab "Loops" [ref=e615] [cursor=pointer]
        - tab "Log History" [ref=e616] [cursor=pointer]
        - tab "Integrations" [ref=e617] [cursor=pointer]
        - tab "Appearance" [ref=e618] [cursor=pointer]
      - button "Close utilities" [ref=e619] [cursor=pointer]:
        - generic [ref=e620]: ✕
    - generic [ref=e621]:
      - complementary [ref=e622]:
        - generic [ref=e626]:
          - searchbox "Search settings items" [active] [ref=e627]: Comfortably Numb
          - button "Filters" [ref=e629] [cursor=pointer]
        - generic [ref=e630]:
          - button "Artwork for Comfortably Numb Sidebar Fixture 01 Comfortably Numb Sidebar Fixture 01 Generated Problem Fixture · 2023" [ref=e631] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 01" [ref=e633]:
              - img [ref=e635]
            - generic [ref=e642]:
              - generic [ref=e643]: Comfortably Numb Sidebar Fixture 01
              - generic [ref=e644]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 02 Comfortably Numb Sidebar Fixture 02 Generated Problem Fixture · 2023" [ref=e645] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 02" [ref=e647]:
              - img [ref=e649]
            - generic [ref=e656]:
              - generic [ref=e657]: Comfortably Numb Sidebar Fixture 02
              - generic [ref=e658]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 03 Comfortably Numb Sidebar Fixture 03 Generated Problem Fixture · 2023" [ref=e659] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 03" [ref=e661]:
              - img [ref=e663]
            - generic [ref=e670]:
              - generic [ref=e671]: Comfortably Numb Sidebar Fixture 03
              - generic [ref=e672]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 04 Comfortably Numb Sidebar Fixture 04 Generated Problem Fixture · 2023" [ref=e673] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 04" [ref=e675]:
              - img [ref=e677]
            - generic [ref=e684]:
              - generic [ref=e685]: Comfortably Numb Sidebar Fixture 04
              - generic [ref=e686]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 05 Comfortably Numb Sidebar Fixture 05 Generated Problem Fixture · 2023" [ref=e687] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 05" [ref=e689]:
              - img [ref=e691]
            - generic [ref=e698]:
              - generic [ref=e699]: Comfortably Numb Sidebar Fixture 05
              - generic [ref=e700]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 06 Comfortably Numb Sidebar Fixture 06 Generated Problem Fixture · 2023" [ref=e701] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 06" [ref=e703]:
              - img [ref=e705]
            - generic [ref=e712]:
              - generic [ref=e713]: Comfortably Numb Sidebar Fixture 06
              - generic [ref=e714]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 07 Comfortably Numb Sidebar Fixture 07 Generated Problem Fixture · 2023" [ref=e715] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 07" [ref=e717]:
              - img [ref=e719]
            - generic [ref=e726]:
              - generic [ref=e727]: Comfortably Numb Sidebar Fixture 07
              - generic [ref=e728]: Generated Problem Fixture · 2023
          - button "Artwork for Comfortably Numb Sidebar Fixture 08 Comfortably Numb Sidebar Fixture 08 Generated Problem Fixture · 2023" [ref=e729] [cursor=pointer]:
            - generic "Artwork for Comfortably Numb Sidebar Fixture 08" [ref=e731]:
              - img [ref=e733]
            - generic [ref=e740]:
              - generic [ref=e741]: Comfortably Numb Sidebar Fixture 08
              - generic [ref=e742]: Generated Problem Fixture · 2023
          - button "Artwork for Neal Morse Plays Pink Floyd Neal Morse Plays Pink Floyd Neal Morse · 2023" [ref=e743] [cursor=pointer]:
            - generic "Artwork for Neal Morse Plays Pink Floyd" [ref=e745]:
              - img [ref=e747]
            - generic [ref=e754]:
              - generic [ref=e755]: Neal Morse Plays Pink Floyd
              - generic [ref=e756]: Neal Morse · 2023
      - tabpanel "Problematic files" [ref=e757]:
        - generic [ref=e758]:
          - generic "Album cover for Comfortably Numb Sidebar Fixture 01" [ref=e760]:
            - img [ref=e762]
          - generic [ref=e769]:
            - heading "Comfortably Numb Sidebar Fixture 01" [level=3] [ref=e770]
            - generic [ref=e771]: Generated Problem Fixture
            - generic [ref=e772]: "Year: 2023"
            - generic [ref=e773]: "Tracks: 18"
            - generic [ref=e774]: "File types: MP3"
          - generic [ref=e775]:
            - button "Open In File Explorer" [ref=e776] [cursor=pointer]
            - button "Edit Tags" [ref=e779] [cursor=pointer]:
              - img [ref=e781]
            - button "Fetch cover" [ref=e783] [cursor=pointer]:
              - img [ref=e785]
            - button "Find on Discogs" [ref=e787] [cursor=pointer]:
              - img [ref=e789]
        - status
        - button "Missing cover art" [ref=e792] [cursor=pointer]
        - heading "Detected problems" [level=4] [ref=e793]
        - table "Detected problems" [ref=e795]:
          - row "Track / file Problems Suggested edits" [ref=e796]:
            - columnheader "Track / file" [ref=e797]
            - columnheader "Problems" [ref=e798]
            - columnheader "Suggested edits" [ref=e799]
          - rowgroup [ref=e800]:
            - row "Track / file Problems Suggested edits" [ref=e801]:
              - cell "Track / file" [ref=e802]:
                - generic [ref=e803]: Comfortably Numb
                - generic [ref=e804]: MP3
              - cell "Problems" [ref=e805]:
                - button "Missing track number" [ref=e807] [cursor=pointer]
              - cell "Suggested edits"
        - generic [ref=e808]:
          - button "Create Exception" [disabled] [ref=e809]:
            - generic [ref=e810]: Create Exception
          - button "Apply All" [disabled] [ref=e811]:
            - generic [ref=e812]: Apply All
```

# Test source

```ts
  1  | const PRODUCTION_BOOTSTRAP_ASSIGNMENT_PATTERN = (
  2  |   /(?:^|[;\r\n])\s*window\.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__\s*=\s*/u
  3  | );
  4  | 
  5  | function readBootstrapJsonAssignment(source, start) {
  6  |   let quoted = false;
  7  |   let escaped = false;
  8  |   for (let index = start; index < source.length; index += 1) {
  9  |     const character = source[index];
  10 |     if (quoted) {
  11 |       if (escaped) escaped = false;
  12 |       else if (character === '\\') escaped = true;
  13 |       else if (character === '"') quoted = false;
  14 |     } else if (character === '"') {
  15 |       quoted = true;
  16 |     } else if (character === ';') {
  17 |       return JSON.parse(source.slice(start, index));
  18 |     }
  19 |   }
  20 |   throw new SyntaxError('Expected a terminated JSON assignment.');
  21 | }
  22 | 
  23 | export function parseProductionBootstrapPayloadScriptSources(scriptSources = []) {
  24 |   for (let index = scriptSources.length - 1; index >= 0; index -= 1) {
  25 |     const source = String(scriptSources[index] || '');
  26 |     const match = source.match(PRODUCTION_BOOTSTRAP_ASSIGNMENT_PATTERN);
  27 |     if (!match) continue;
  28 |     try {
  29 |       return readBootstrapJsonAssignment(source, match.index + match[0].length);
  30 |     } catch (error) {
  31 |       throw new Error(
  32 |         `Production bootstrap payload script contained invalid JSON: ${error.message}`,
  33 |         { cause: error },
  34 |       );
  35 |     }
  36 |   }
  37 |   throw new Error('Expected the production bootstrap payload script on the current document.');
  38 | }
  39 | 
  40 | export class BasePage {
  41 |   constructor(page, testInfo = null) {
  42 |     this.page = page;
  43 |     this.testInfo = testInfo;
  44 |   }
  45 | 
  46 |   async goto(pathname = '/', options = {}) {
  47 |     await this.page.goto(pathname, {
  48 |       waitUntil: options.waitUntil || 'domcontentloaded',
  49 |     });
  50 |   }
  51 | 
  52 |   async click(locator, options = {}) {
  53 |     await locator.click(options);
  54 |   }
  55 | 
  56 |   async waitForVisible(locator, options = {}) {
  57 |     await locator.waitFor({
  58 |       state: 'visible',
  59 |       timeout: options.timeout,
  60 |     });
  61 |   }
  62 | 
  63 |   async waitForHidden(locator, options = {}) {
  64 |     await locator.waitFor({
  65 |       state: 'hidden',
  66 |       timeout: options.timeout,
  67 |     });
  68 |   }
  69 | 
  70 |   async waitForPageCondition(callback, options = {}, arg = null) {
> 71 |     await this.page.waitForFunction(callback, arg, options);
     |                     ^ TimeoutError: page.waitForFunction: Timeout 60000ms exceeded.
  72 |   }
  73 | 
  74 |   async readProductionBootstrapPayload() {
  75 |     const scriptSources = await this.page.locator('script').allTextContents();
  76 |     return parseProductionBootstrapPayloadScriptSources(scriptSources);
  77 |   }
  78 | }
  79 | 
```