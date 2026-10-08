/**
 * Placement for the injected shell entry.
 *
 * DELIBERATELY DUMB, and here is why.
 *
 * The first version measured the shell: find the "工作区" heading by its text, then
 * the session list under it, then sit below that. It failed repeatedly, and every
 * fix exposed another way the approach was unsound:
 *
 *   - when the sidebar is COLLAPSED the label text is not in the DOM at all, so
 *     there is nothing to find (measured: sidebar width 56px, no 工作区 node);
 *   - the real rows are containers with child elements, so a "leaf text node" rule
 *     skipped exactly the rows that mattered;
 *   - class names are build-hashed, so nothing can be anchored on them;
 *   - React re-renders move the target, so any measurement is a snapshot;
 *   - each round needed a fixture that imitated the shell, and the fixture was
 *     never quite the shell — twice a failure was an artifact of the fixture or of
 *     the check itself rather than of the page.
 *
 * So the entry no longer measures anything. It sits in a fixed slot at the bottom
 * of the window, in the left column, where the reserved strip and the sticky styles
 * keep it clear of the shell's own chrome. That is stable across collapse,
 * re-render and shell version changes, and it is verifiable without imitating the
 * shell.
 *
 * The proper fix, if a native seat is ever wanted, is a real client module
 * registering into `sidebar.panellist` / `sidebar.footer.action`. That is written
 * (lib/client.js) but currently blocked by an unexplained activation failure; see
 * cordis.patch.yml.
 *
 * This is served to the page as an inline script but lives in its own file so
 * ordinary tooling can see it. A string embedded in `lib/plugin.js` is invisible to
 * `node --check`, and a syntax error there fails ONLY in the browser: the entry
 * stays `display:none` on every launch while every host-side check is green. That
 * is exactly what happened once — a malformed block comment.
 */
export function entryPositionScript(entryId) {
  return `(function(){
  var ID = ${JSON.stringify(entryId)};

  function place(){
    var entry = document.getElementById(ID);
    if (entry === null) return;

    // Bottom of the window, inside the left column, raised clear of the sidebar's
    // own foot controls (settings, footer actions, the account row). Nothing is
    // measured, so nothing can be mis-measured; the only inputs are constants.
    entry.style.top = 'auto';
    entry.style.bottom = '44px';
    entry.style.left = '8px';
    entry.style.maxWidth = '240px';
    entry.setAttribute('data-placed', '');
  }

  place();
  // The shell may mount its own tree after us; re-assert without measuring.
  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(function(){ place(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;
}
