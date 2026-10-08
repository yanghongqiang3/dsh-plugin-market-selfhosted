/**
 * Placement for the injected shell entry.
 *
 * This is served to the page as an inline script, but it lives in its own file so
 * ordinary tooling can see it. A string embedded in `lib/plugin.js` is invisible to
 * `node --check`, and a syntax error there fails ONLY in the browser: the entry
 * stays `display:none` on every launch while every host-side check stays green.
 * That is exactly what happened once — a malformed block comment.
 *
 * It runs at the end of the shell document, so the entry element already exists.
 * Everything is best-effort and silent; it must never throw, because a throw here
 * leaves the entry unplaced.
 */
export function entryPositionScript(entryId) {
  return `(function(){
  var ID = ${JSON.stringify(entryId)};
  // GAP is the clear space kept on each side of the entry.
  var GAP = 4, HEIGHT = 24, PAD = 8;
  // Fallback slot used when the sidebar's heading cannot be measured — it is
  // absent entirely while the sidebar is collapsed.
  var FALLBACK_TOP = 88;
  var LABELS = ['工作区', 'Workspaces', 'Workspace'];
  var LEFT_TOLERANCE = 24;

  function isCandidate(el, entry){
    if (el === entry || el.id === ID) return false;
    var tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK' || tag === 'SVG' || tag === 'PATH') return false;
    if (el.children.length > 0) return false;
    var t = (el.textContent || '').trim();
    if (t.length === 0 || t.length > 60) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.height > 60) return false;
    return true;
  }

  function inColumn(r, box){
    return Math.abs(r.left - box.left) <= LEFT_TOLERANCE && r.right <= box.right;
  }

  /** The "工作区" heading, found by its own text: class names are build-hashed. */
  function findHeading(){
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++){
      var el = all[i];
      var t = (el.textContent || '').trim();
      if (t.length === 0 || t.length > 16) continue;
      if (LABELS.indexOf(t) === -1) continue;
      var r = el.getBoundingClientRect();
      // Must look like a column header: left side of the window, narrow.
      if (r.width > 0 && r.height > 0 && r.left < 140 && r.top > 40 && r.width < 340) return el;
    }
    return null;
  }

  /** Bottom edge of the lowest row in the heading's column. */
  function lowestRowBottom(box, entry){
    var lowest = null;
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++){
      var el = all[i];
      if (!isCandidate(el, entry)) continue;
      var r = el.getBoundingClientRect();
      if (!inColumn(r, box)) continue;
      if (r.top < box.bottom) continue;
      if (lowest === null || r.bottom > lowest) lowest = r.bottom;
    }
    return lowest;
  }

  /** Top edge of the sidebar's foot area, which is pinned near the bottom. */
  function footTop(box, entry){
    var candidate = null;
    var floor = window.innerHeight * 0.5;
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++){
      var el = all[i];
      if (!isCandidate(el, entry)) continue;
      var r = el.getBoundingClientRect();
      if (!inColumn(r, box)) continue;
      if (r.top < floor) continue;
      if (candidate === null || r.top < candidate) candidate = r.top;
    }
    return candidate;
  }

  function mark(entry, top, maxWidth){
    entry.style.top = Math.round(top) + 'px';
    entry.style.maxWidth = Math.round(maxWidth) + 'px';
    entry.setAttribute('data-placed', '');
  }

  function place(){
    var entry = document.getElementById(ID);
    if (entry === null) return;

    var heading = findHeading();
    if (heading === null){
      // Collapsed sidebar, or markup we do not recognise. A visible entry in an
      // imperfect spot is better than one that silently disappears.
      mark(entry, FALLBACK_TOP, 240);
      return;
    }

    var box = heading.getBoundingClientRect();

    // Two candidate slots, best first: directly under the column's lowest row
    // (right below the session list), or just above the foot controls.
    var rowBottom = lowestRowBottom(box, entry);
    var foot = footTop(box, entry);
    var candidateA = rowBottom === null ? null : rowBottom + GAP;
    var candidateB = foot === null ? null : foot - GAP - HEIGHT;

    var top;
    if (candidateA !== null && (foot === null || candidateA + HEIGHT <= foot - GAP)) top = candidateA;
    else if (candidateB !== null) top = candidateB;
    else if (candidateA !== null) top = candidateA;
    else top = box.bottom + GAP;

    var limit = window.innerHeight - HEIGHT - PAD;
    if (top > limit) top = limit;
    if (top < 0) { mark(entry, FALLBACK_TOP, box.right - PAD); return; }

    mark(entry, top, Math.max(120, box.right - PAD));
  }

  var queued = false;
  function schedule(){
    if (queued) return;
    queued = true;
    requestAnimationFrame(function(){ queued = false; place(); });
  }

  place();
  window.addEventListener('resize', schedule, { passive: true });
  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(function(mutations){
      for (var i = 0; i < mutations.length; i++){
        var target = mutations[i].target;
        if (target && target.nodeType === 1 && target.id === ID) continue;
        schedule();
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  // The sidebar animates open and closed, so keep re-measuring briefly after load.
  var ticks = 0;
  var timer = setInterval(function(){ place(); if (++ticks > 20) clearInterval(timer); }, 250);
})();`;
}
