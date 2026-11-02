# Decoder notice supplement — private review proposal

This supplement does not replace the original NOTICE or establish complete
binary/source provenance. The two bundled decoder files remain unchanged.

The JavaScript wrappers are by Ethan Halsall and identified as MIT by the
upstream project. LICENSE-WASM-WRAPPER-MIT.txt combines the exact copyright
years visible in the bundled headers with the standard MIT permission text
from https://opensource.org/license/mit . It is a notice reconstruction,
not an asserted byte-identical upstream package LICENSE file.

libFLAC is by Josh Coalson and Xiph.Org Foundation. LICENSE-LIBFLAC-BSD.txt
is the full upstream COPYING.Xiph text retrieved from
https://raw.githubusercontent.com/xiph/flac/master/COPYING.Xiph . Its current
copyright extent is not a determination of the exact compiled revision.

The upstream project also identifies puff (Mark Adler, zlib) as the WASM
inflater. Its license header is retained in review evidence. flac package
metadata identifies codec-parser 2.5.0; common 9.0.7 identifies
@eshaz/web-worker 1.2.2 and simple-yenc ^1.0.4. Those dependencies must be
resolved against the exact bundle build before this can be a complete notice
inventory. codec-parser 2.5.0 upstream metadata specifies LGPL-3.0-or-later. Its full
LGPL-3.0 text and incorporated GPL-3.0 text are included as separate files,
separate from
the existing mpg123 LGPL-2.1 text. No representation of full license compliance
or of satisfied corresponding-source/replacement conditions is made here.
