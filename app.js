(() => {
  "use strict";

  const MAX_PANES = 4;
  const STORAGE_KEY = "proofroom-v1";
  const letters = ["A", "B", "C", "D"];
  const defaultNames = ["基準稿", "版本 B", "版本 C", "版本 D"];
  const state = {
    paneCount: 3,
    mode: "smart",
    highlight: true,
    activePane: 0,
    panes: Array.from({ length: MAX_PANES }, (_, i) => ({ name: defaultNames[i], text: "" })),
    matches: [],
    matchIndex: -1,
  };

  const grid = document.querySelector("#editorGrid");
  const paneTemplate = document.querySelector("#paneTemplate");
  const summary = document.querySelector("#compareSummary");
  const findPanel = document.querySelector("#findPanel");
  const findInput = document.querySelector("#findInput");
  const replaceInput = document.querySelector("#replaceInput");
  const caseSensitive = document.querySelector("#caseSensitive");
  const allPanes = document.querySelector("#allPanes");
  const findCount = document.querySelector("#findCount");
  const toast = document.querySelector("#toast");
  let renderTimer = 0;
  let toastTimer = 0;

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) return;
      state.paneCount = [2, 3, 4].includes(saved.paneCount) ? saved.paneCount : 3;
      state.mode = saved.mode === "line" ? "line" : "smart";
      state.highlight = saved.highlight !== false;
      if (Array.isArray(saved.panes)) {
        saved.panes.slice(0, MAX_PANES).forEach((pane, i) => {
          state.panes[i].name = typeof pane.name === "string" ? pane.name : defaultNames[i];
          state.panes[i].text = typeof pane.text === "string" ? pane.text : "";
        });
      }
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        paneCount: state.paneCount,
        mode: state.mode,
        highlight: state.highlight,
        panes: state.panes,
      }));
    } catch (_) {
      // The editor still works if storage is unavailable or full.
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  }

  function tokenize(text) {
    const regex = /\p{Script=Han}|[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+|\s+/gu;
    const tokens = [];
    let match;
    while ((match = regex.exec(text))) {
      tokens.push({ value: match[0], start: match.index, end: match.index + match[0].length });
    }
    return tokens;
  }

  function normalizedTokens(text) {
    return tokenize(text)
      .map(item => item.value.trim().toLocaleLowerCase())
      .filter(Boolean);
  }

  function diceSimilarity(a, b) {
    const ta = normalizedTokens(a);
    const tb = normalizedTokens(b);
    if (!ta.length && !tb.length) return 1;
    if (!ta.length || !tb.length) return 0;
    const counts = new Map();
    ta.forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
    let overlap = 0;
    tb.forEach(token => {
      const count = counts.get(token) || 0;
      if (count > 0) {
        overlap += 1;
        counts.set(token, count - 1);
      }
    });
    return (2 * overlap) / (ta.length + tb.length);
  }

  function lcsTokenRanges(a, b) {
    const at = tokenize(a).filter(t => t.value.trim());
    const bt = tokenize(b).filter(t => t.value.trim());
    if (!at.length || !bt.length || at.length * bt.length > 250000) return [[], []];
    const rows = at.length + 1;
    const cols = bt.length + 1;
    const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        if (at[i - 1].value.toLocaleLowerCase() === bt[j - 1].value.toLocaleLowerCase()) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    const ai = [];
    const bi = [];
    let i = at.length;
    let j = bt.length;
    while (i > 0 && j > 0) {
      if (at[i - 1].value.toLocaleLowerCase() === bt[j - 1].value.toLocaleLowerCase()) {
        ai.push([at[i - 1].start, at[i - 1].end]);
        bi.push([bt[j - 1].start, bt[j - 1].end]);
        i -= 1;
        j -= 1;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i -= 1;
      } else {
        j -= 1;
      }
    }
    return [ai.reverse(), bi.reverse()];
  }

  function buildLinePairs(linesA, linesB, mode) {
    if (mode === "line") {
      const total = Math.max(linesA.length, linesB.length);
      return Array.from({ length: total }, (_, i) => [i, i, diceSimilarity(linesA[i] || "", linesB[i] || "")]);
    }
    const candidates = [];
    const tokenIndex = new Map();
    linesB.forEach((line, bi) => {
      new Set(normalizedTokens(line)).forEach(token => {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push(bi);
      });
    });
    linesA.forEach((a, ai) => {
      if (!a.trim()) return;
      const possible = new Set();
      new Set(normalizedTokens(a)).forEach(token => {
        (tokenIndex.get(token) || []).forEach(bi => possible.add(bi));
      });
      possible.forEach(bi => {
        const score = diceSimilarity(a, linesB[bi]);
        if (score >= 0.25) candidates.push([ai, bi, score]);
      });
    });
    candidates.sort((x, y) => y[2] - x[2]);
    const usedA = new Set();
    const usedB = new Set();
    return candidates.filter(([ai, bi]) => {
      if (usedA.has(ai) || usedB.has(bi)) return false;
      usedA.add(ai);
      usedB.add(bi);
      return true;
    });
  }

  function collectHighlights(texts) {
    const lineSets = texts.map(text => text.split("\n"));
    const marks = lineSets.map(lines => lines.map(line => new Uint8Array(line.length)));
    for (let a = 0; a < lineSets.length; a += 1) {
      for (let b = a + 1; b < lineSets.length; b += 1) {
        const pairs = buildLinePairs(lineSets[a], lineSets[b], state.mode);
        pairs.forEach(([ai, bi, score]) => {
          const lineA = lineSets[a][ai] || "";
          const lineB = lineSets[b][bi] || "";
          if (!lineA && !lineB) return;
          if (lineA === lineB) {
            marks[a][ai].fill(2);
            marks[b][bi].fill(2);
            return;
          }
          if (score < 0.25) return;
          const [rangesA, rangesB] = lcsTokenRanges(lineA, lineB);
          rangesA.forEach(([start, end]) => marks[a][ai].fill(1, start, end));
          rangesB.forEach(([start, end]) => marks[b][bi].fill(1, start, end));
        });
      }
    }
    return { lineSets, marks };
  }

  function getSearchRanges(text, paneIndex) {
    if (!findInput.value) return [];
    if (!allPanes.checked && paneIndex !== state.activePane) return [];
    const ranges = [];
    const source = caseSensitive.checked ? text : text.toLocaleLowerCase();
    const needle = caseSensitive.checked ? findInput.value : findInput.value.toLocaleLowerCase();
    let start = 0;
    while (needle && start <= source.length) {
      const index = source.indexOf(needle, start);
      if (index < 0) break;
      const globalIndex = state.matches.findIndex(m => m.paneIndex === paneIndex && m.start === index);
      ranges.push({ start: index, end: index + needle.length, current: globalIndex === state.matchIndex });
      start = index + Math.max(needle.length, 1);
    }
    return ranges;
  }

  function renderMarkedText(text, lineMarks, searchRanges) {
    let absolute = 0;
    return text.split("\n").map((line, lineIndex) => {
      const marks = lineMarks[lineIndex] || new Uint8Array(line.length);
      const boundaries = new Set([0, line.length]);
      for (let i = 1; i < marks.length; i += 1) if (marks[i] !== marks[i - 1]) boundaries.add(i);
      searchRanges.forEach(range => {
        const lineStart = absolute;
        const lineEnd = absolute + line.length;
        if (range.start <= lineEnd && range.end >= lineStart) {
          boundaries.add(Math.max(0, range.start - lineStart));
          boundaries.add(Math.min(line.length, range.end - lineStart));
        }
      });
      const sorted = [...boundaries].sort((a, b) => a - b);
      let html = "";
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const from = sorted[i];
        const to = sorted[i + 1];
        const absFrom = absolute + from;
        const absTo = absolute + to;
        const classes = [];
        if (state.highlight && marks[from] === 2) classes.push("exact-match");
        else if (state.highlight && marks[from] === 1) classes.push("similar-match");
        const searchRange = searchRanges.find(range => range.start < absTo && range.end > absFrom);
        if (searchRange) classes.push(searchRange.current ? "search-current" : "search-match");
        const value = escapeHtml(line.slice(from, to));
        html += classes.length ? `<mark class="${classes.join(" ")}">${value}</mark>` : value;
      }
      absolute += line.length + 1;
      return `<span class="line">${html || "\u200b"}</span>`;
    }).join("\n") + "\n";
  }

  function calculateOverallSimilarity(texts) {
    const usable = texts.filter(text => text.length > 0);
    if (usable.length < 2) return null;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        sum += diceSimilarity(usable[i], usable[j]);
        pairs += 1;
      }
    }
    return Math.round((sum / pairs) * 100);
  }

  function updateMatches(resetIndex = false) {
    const scopes = allPanes.checked ? [...Array(state.paneCount).keys()] : [state.activePane];
    const needleRaw = findInput.value;
    const needle = caseSensitive.checked ? needleRaw : needleRaw.toLocaleLowerCase();
    state.matches = [];
    if (needle) {
      scopes.forEach(paneIndex => {
        const raw = state.panes[paneIndex].text;
        const source = caseSensitive.checked ? raw : raw.toLocaleLowerCase();
        let start = 0;
        while (start <= source.length) {
          const index = source.indexOf(needle, start);
          if (index < 0) break;
          state.matches.push({ paneIndex, start: index, end: index + needle.length });
          start = index + Math.max(needle.length, 1);
        }
      });
    }
    if (resetIndex || state.matchIndex >= state.matches.length) state.matchIndex = state.matches.length ? 0 : -1;
    findCount.textContent = state.matches.length ? `${Math.max(state.matchIndex + 1, 1)} / ${state.matches.length}` : "0 筆";
  }

  function renderComparison() {
    const panes = [...grid.querySelectorAll(".editor-pane")];
    const texts = state.panes.slice(0, state.paneCount).map(p => p.text);
    const { marks } = collectHighlights(texts);
    updateMatches(false);
    panes.forEach((pane, i) => {
      const editor = pane.querySelector(".text-editor");
      const layer = pane.querySelector(".highlight-layer");
      const ranges = getSearchRanges(state.panes[i].text, i);
      layer.innerHTML = state.panes[i].text
        ? renderMarkedText(state.panes[i].text, marks[i], ranges)
        : `<span class="editor-placeholder">${escapeHtml(editor.placeholder)}</span>`;
      const text = state.panes[i].text;
      const chars = [...text.replace(/\s/g, "")].length;
      const lines = text.split("\n").length;
      pane.querySelector(".pane-stats").textContent = `${chars.toLocaleString()} 字 · ${lines.toLocaleString()} 行`;
      const status = pane.querySelector(".pane-status");
      if (!text) {
        status.textContent = "尚未輸入";
        status.className = "pane-status";
      } else if (i === 0) {
        status.textContent = "比較基準";
        status.className = "pane-status is-match";
      } else {
        const similarity = Math.round(diceSimilarity(texts[0], text) * 100);
        status.textContent = `與 A 相似 ${similarity}%`;
        status.className = `pane-status ${similarity === 100 ? "is-match" : "is-similar"}`;
      }
      syncScroll(editor, layer);
    });
    const overall = calculateOverallSimilarity(texts);
    summary.textContent = overall === null ? "等待至少兩份稿件" : `整體一致度 ${overall}% · ${state.mode === "smart" ? "智慧相似" : "逐行對比"}`;
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderComparison, 90);
  }

  function syncScroll(editor, layer) {
    layer.scrollTop = editor.scrollTop;
    layer.scrollLeft = editor.scrollLeft;
  }

  function buildPanes() {
    grid.replaceChildren();
    grid.dataset.count = state.paneCount;
    grid.style.setProperty("--pane-count", state.paneCount);
    for (let i = 0; i < state.paneCount; i += 1) {
      const pane = paneTemplate.content.firstElementChild.cloneNode(true);
      pane.dataset.index = i;
      pane.querySelector(".pane-letter").textContent = letters[i];
      const title = pane.querySelector(".pane-title");
      const editor = pane.querySelector(".text-editor");
      const layer = pane.querySelector(".highlight-layer");
      title.value = state.panes[i].name;
      editor.value = state.panes[i].text;
      editor.setAttribute("aria-label", `${state.panes[i].name}內容`);
      editor.placeholder = i === 0 ? "在這裡貼上基準稿……" : `在這裡貼上${defaultNames[i]}……`;
      title.addEventListener("input", () => {
        state.panes[i].name = title.value;
        editor.setAttribute("aria-label", `${title.value || letters[i] + " 稿"}內容`);
        save();
      });
      editor.addEventListener("input", () => {
        state.panes[i].text = editor.value;
        save();
        scheduleRender();
      });
      editor.addEventListener("scroll", () => syncScroll(editor, layer));
      editor.addEventListener("focus", () => setActivePane(i));
      title.addEventListener("focus", () => setActivePane(i));
      pane.querySelector(".copy-button").addEventListener("click", () => copyPane(i));
      pane.querySelector(".paste-button").addEventListener("click", () => pastePane(i));
      grid.append(pane);
    }
    setActivePane(Math.min(state.activePane, state.paneCount - 1));
    renderComparison();
  }

  function setActivePane(index) {
    state.activePane = index;
    grid.querySelectorAll(".editor-pane").forEach((pane, i) => pane.classList.toggle("is-focused", i === index));
    updateMatches(true);
    scheduleRender();
  }

  async function copyPane(index) {
    try {
      await navigator.clipboard.writeText(state.panes[index].text);
      showToast(`${letters[index]} 稿已複製`);
    } catch (_) {
      const editor = grid.querySelector(`.editor-pane[data-index="${index}"] .text-editor`);
      editor.focus();
      editor.select();
      document.execCommand("copy");
      showToast(`${letters[index]} 稿已複製`);
    }
  }

  async function pastePane(index) {
    try {
      const pasted = await navigator.clipboard.readText();
      const editor = grid.querySelector(`.editor-pane[data-index="${index}"] .text-editor`);
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText(pasted, start, end, "end");
      state.panes[index].text = editor.value;
      save();
      renderComparison();
      editor.focus();
      showToast(`已貼到 ${letters[index]} 稿`);
    } catch (_) {
      showToast("瀏覽器未允許讀取剪貼簿，請使用 Ctrl＋V");
      grid.querySelector(`.editor-pane[data-index="${index}"] .text-editor`).focus();
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1900);
  }

  function toggleFind(force) {
    const shouldOpen = typeof force === "boolean" ? force : findPanel.hidden;
    findPanel.hidden = !shouldOpen;
    document.querySelector("#openFind").setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      findInput.focus();
      findInput.select();
    }
  }

  function goToMatch(direction) {
    updateMatches(false);
    if (!state.matches.length) return;
    state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length;
    const match = state.matches[state.matchIndex];
    state.activePane = match.paneIndex;
    const editor = grid.querySelector(`.editor-pane[data-index="${match.paneIndex}"] .text-editor`);
    setActivePane(match.paneIndex);
    editor.focus();
    editor.setSelectionRange(match.start, match.end);
    const before = editor.value.slice(0, match.start).split("\n").length - 1;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 25;
    editor.scrollTop = Math.max(0, before * lineHeight - editor.clientHeight / 3);
    renderComparison();
  }

  function replaceCurrent() {
    updateMatches(false);
    if (!state.matches.length) return;
    const match = state.matches[Math.max(state.matchIndex, 0)];
    const pane = state.panes[match.paneIndex];
    pane.text = pane.text.slice(0, match.start) + replaceInput.value + pane.text.slice(match.end);
    const editor = grid.querySelector(`.editor-pane[data-index="${match.paneIndex}"] .text-editor`);
    editor.value = pane.text;
    save();
    updateMatches(true);
    renderComparison();
    showToast("已取代 1 筆");
  }

  function replaceEveryMatch() {
    updateMatches(false);
    if (!state.matches.length) return;
    const total = state.matches.length;
    const byPane = new Map();
    state.matches.forEach(match => {
      if (!byPane.has(match.paneIndex)) byPane.set(match.paneIndex, []);
      byPane.get(match.paneIndex).push(match);
    });
    byPane.forEach((matches, paneIndex) => {
      let text = state.panes[paneIndex].text;
      matches.sort((a, b) => b.start - a.start).forEach(match => {
        text = text.slice(0, match.start) + replaceInput.value + text.slice(match.end);
      });
      state.panes[paneIndex].text = text;
      grid.querySelector(`.editor-pane[data-index="${paneIndex}"] .text-editor`).value = text;
    });
    save();
    updateMatches(true);
    renderComparison();
    showToast(`已取代 ${total} 筆`);
  }

  function bindControls() {
    document.querySelectorAll("#paneCount button").forEach(button => button.addEventListener("click", () => {
      state.paneCount = Number(button.dataset.count);
      document.querySelectorAll("#paneCount button").forEach(b => b.classList.toggle("is-active", b === button));
      save();
      buildPanes();
    }));
    document.querySelectorAll("#compareMode button").forEach(button => button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      document.querySelectorAll("#compareMode button").forEach(b => b.classList.toggle("is-active", b === button));
      save();
      renderComparison();
    }));
    document.querySelector("#highlightToggle").addEventListener("change", event => {
      state.highlight = event.target.checked;
      save();
      renderComparison();
    });
    document.querySelector("#openFind").addEventListener("click", () => toggleFind());
    document.querySelector("#closeFind").addEventListener("click", () => toggleFind(false));
    document.querySelector("#findNext").addEventListener("click", () => goToMatch(1));
    document.querySelector("#findPrev").addEventListener("click", () => goToMatch(-1));
    document.querySelector("#replaceOne").addEventListener("click", replaceCurrent);
    document.querySelector("#replaceAll").addEventListener("click", replaceEveryMatch);
    [findInput, caseSensitive, allPanes].forEach(element => element.addEventListener("input", () => {
      updateMatches(true);
      renderComparison();
    }));
    findInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToMatch(event.shiftKey ? -1 : 1);
      }
      if (event.key === "Escape") toggleFind(false);
    });
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        toggleFind(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "h") {
        event.preventDefault();
        toggleFind(true);
        replaceInput.focus();
      }
      if (event.key === "Escape" && !findPanel.hidden) toggleFind(false);
    });
  }

  function syncControlState() {
    document.querySelectorAll("#paneCount button").forEach(button => button.classList.toggle("is-active", Number(button.dataset.count) === state.paneCount));
    document.querySelectorAll("#compareMode button").forEach(button => button.classList.toggle("is-active", button.dataset.mode === state.mode));
    document.querySelector("#highlightToggle").checked = state.highlight;
  }

  restore();
  syncControlState();
  bindControls();
  buildPanes();
})();
