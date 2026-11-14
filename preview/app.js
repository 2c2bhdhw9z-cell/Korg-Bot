"use strict";

// Original Korg design preview, MIT-0. URL entries are inert metadata.
(() => {
  const $ = selector => document.querySelector(selector);
  const palettes = ["graphite", "ember", "glacier", "orchard", "plum", "paper"];
  const backgrounds = ["#171A1D", "#201916", "#151D22", "#192019", "#211A20", "#F2F2EE"];
  const storageKey = "korg.original.preview.palette.v1";
  const entries = new Map();
  const title = value => value.charAt(0).toUpperCase() + value.slice(1);
  let selected = "graphite";

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function choose(name, persist = false) {
    if (!palettes.includes(name)) return;
    selected = name;
    document.documentElement.dataset.palette = name;
    $("meta[name='theme-color']").content = backgrounds[palettes.indexOf(name)];
    $("#palette-name").textContent = title(name);
    document.querySelectorAll("input[name='palette']").forEach(input => { input.checked = input.value === name; });
    if (!persist) return;
    try {
      localStorage.setItem(storageKey, name);
      $("#palette-status").textContent = `${title(name)} saved in this browser.`;
    } catch {
      $("#palette-status").textContent = `${title(name)} selected for this visit. Browser storage is unavailable.`;
    }
  }
  for (const name of palettes) {
    const label = node("label", undefined, "palette");
    label.dataset.swatch = name;
    const input = node("input");
    input.type = "radio";
    input.name = "palette";
    input.value = name;
    input.checked = name === selected;
    const swatch = node("span", undefined, "swatch");
    swatch.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => choose(name, true));
    label.append(input, swatch, node("span", title(name)));
    $("#palettes").append(label);
  }
  try {
    const saved = localStorage.getItem(storageKey);
    if (palettes.includes(saved)) selected = saved;
  } catch {
    $("#palette-status").textContent = "Palettes work for this visit. Browser storage is unavailable.";
  }
  choose(selected);

  function renderEntries() {
    $("#entries").replaceChildren();
    $("#empty").hidden = entries.size > 0;
    $("#entry-count").textContent = `${entries.size} ${entries.size === 1 ? "ENTRY" : "ENTRIES"}`;
    for (const [key, item] of entries) {
      const row = node("li");
      const copy = node("div");
      copy.append(node("strong", item.kind === "bundle" ? "Bundle URL · demo only" : "Manifest URL · demo only"), node("small", item.url));
      const remove = node("button", "Remove", "quiet");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove demo address ${item.url}`);
      remove.addEventListener("click", () => {
        entries.delete(key);
        renderEntries();
        $("#url-status").textContent = "Demo metadata removed. No plugin was installed.";
        $("#plugin-url").focus();
      });
      row.append(copy, remove);
      $("#entries").append(row);
    }
  }
  $("#url-form").addEventListener("submit", event => {
    event.preventDefault();
    const input = $("#plugin-url");
    let address;
    try {
      address = new URL(input.value.trim());
      if (address.protocol !== "https:" || address.username || address.password) throw new Error("Invalid address");
    } catch {
      $("#url-status").textContent = "Use an HTTPS address without embedded credentials. It will not be opened.";
      input.focus();
      return;
    }
    const kind = $("#url-kind").value;
    const key = `${kind}:${address.href}`;
    if (entries.has(key)) {
      $("#url-status").textContent = "That demo address is already listed.";
      return;
    }
    if (entries.size >= 20) {
      $("#url-status").textContent = "This demo holds 20 addresses. Remove one to add another.";
      return;
    }
    entries.set(key, { kind, url: address.href });
    renderEntries();
    input.value = "";
    $("#url-status").textContent = "Metadata added for this visit. No download, installation or code execution occurred.";
    input.focus();
  });
  renderEntries();
})();
