from pathlib import Path
p=Path('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js')
s=p.read_text();start=s.index('async function loadUtilityLoops(');end=s.index('function normalizeUtilityLogHistoryRevision(',start)
b=s[start:end].replace('state.utility','utility')
b=b.replace('async function loadUtilityLoops(force = false) {','async function loadUtilityLoops(force = false) {\n  const utility = state.utility;')
b=b.replace('  utility.loopsLoading = true;', '''  const generation = Number(utility.loopDataGeneration || 0) + 1;
  utility.loopDataGeneration = generation;
  const mutationGeneration = Number(utility.loopMutationGeneration || 0);
  const isCurrent = () => state.utility === utility
    && Number(utility.loopDataGeneration || 0) === generation
    && Number(utility.loopMutationGeneration || 0) === mutationGeneration;
  utility.loopsLoading = true;''')
b=b.replace('  utility.loopsLoadPromise = (async () => {','  const loadPromise = (async () => {')
b=b.replace('      const data = await response.json();','      const data = await response.json();\n      if (!isCurrent()) return;')
b=b.replace('    } catch (error) {','    } catch (error) {\n      if (!isCurrent()) return;')
b=b.replace('''      utility.loopsLoading = false;
      utility.loopsLoadPromise = null;
      renderUtilityModalContent();''','''      if (utility.loopsLoadPromise === loadPromise) {
        utility.loopsLoading = false;
        utility.loopsLoadPromise = null;
      }
      if (isCurrent()) renderUtilityModalContent();''')
b=b.replace('  return utility.loopsLoadPromise;\n}', '  utility.loopsLoadPromise = loadPromise;\n  return loadPromise;\n}')
p.write_text(s[:start]+b+s[end:])
