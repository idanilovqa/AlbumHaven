from pathlib import Path
p=Path('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js');s=p.read_text();s=s.replace('      if (isCurrent()) renderUtilityModalContent();','      if (isCurrent() && utility.activeTab === \'loops\') renderUtilityModalContent();');p.write_text(s)
for filename,starts in [('player-loop-playback.js',['async function saveCurrentLoop(']),('utility-loop-playback.js',['async function createLoopFromSavedLoop(','async function deleteSavedLoop('])]:
 p=Path('music_app/static/js/runtime')/filename;s=p.read_text()
 for start in starts:
  a=s.index(start); b=s.index('    state.utility.loops =',a)
  s=s[:b]+'    state.utility.loopMutationGeneration = Number(state.utility.loopMutationGeneration || 0) + 1;\n'+s[b:]
 p.write_text(s)
