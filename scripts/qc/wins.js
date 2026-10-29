// List a process's on-screen windows: "id x y width height layer title".
//   osascript -l JavaScript scripts/qc/wins.js <pid>
// Layer 0 = normal window; >0 = always-on-top. Needs no extra macOS permissions.
ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  return list
    .filter((w) => w.kCGWindowOwnerPID === pid)
    .map((w) => [w.kCGWindowNumber, w.kCGWindowBounds.X, w.kCGWindowBounds.Y, w.kCGWindowBounds.Width, w.kCGWindowBounds.Height, w.kCGWindowLayer, w.kCGWindowName || ''].join(' '))
    .join('\n');
}
