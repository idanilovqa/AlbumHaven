"""Compatibility for the one historical source-indicator filename collision."""

def source_indicator_ledger(applied, checksums):
    """Resolve only the byte-identical source-indicator rename in memory."""
    names = {
        '0080_library_source_indicators.sql',
        '0082_library_source_indicators.sql',
        '0087_library_source_indicators.sql',
    }
    expected = 'e1a292e50a08e4043d2ce3ceda13b87ad90462deb898590c147bab492a01b5e1'
    source_names = names.intersection(checksums)
    if not source_names:
        return dict(applied)
    for name in source_names:
        if checksums[name] != expected:
            raise RuntimeError('Migration checksum mismatch: ' + name)
    recorded = names.intersection(applied)
    for name in recorded:
        if applied[name] != expected:
            raise RuntimeError('Migration checksum mismatch: ' + name)
    compatible = dict(applied)
    if recorded:
        for name in recorded:
            compatible.pop(name)
        compatible.update(dict.fromkeys(source_names, expected))
    return compatible
