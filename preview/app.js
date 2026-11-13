"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  const app = $(".app");
  const input = $("#message-input");
  const sendButton = $(".send-button");
  const conversation = $("#conversation");
  const themeNames = { amethyst: "Amethyst", midnight: "Midnight", discord: "Discord default" };
  const themeColors = { amethyst: "#140F20", midnight: "#07060B", discord: "#1e1f22" };
  const storageKey = "korg.preview.theme.v1";
  const people = {
    mia: { name: "Mia", initials: "mi", color: "lilac" },
    leo: { name: "Leo", initials: "lo", color: "peach" },
    june: { name: "June", initials: "ju", color: "sage" },
    you: { name: "You", initials: "Y", color: "you-avatar" },
  };
  const servers = [
    {
      name: "The Common Room", symbol: "✳", description: "Good music. Half-finished ideas. Your people.",
      channels: [
        {
          id: "on-repeat", name: "on-repeat", topic: "The songs that stay with you.",
          title: "A good place to press play.", description: "New discoveries, old favorites, and one more song.",
          messages: [
            { who: "mia", time: "4:12 PM", text: "Rain on the windows, headphones on. What’s everyone listening to today?" },
            { who: "leo", time: "4:14 PM", text: "Found this in a secondhand record shop. Entire afternoon: sorted.", record: true },
            { who: "june", time: "4:16 PM", text: "That album feels like the last warm evening of summer. Going straight into my painting playlist." },
            { who: "mia", time: "4:18 PM", text: "Exactly the mood I was looking for. Tea is brewing ☕" },
          ],
        },
        {
          id: "sketchbook", name: "sketchbook", topic: "Messy first drafts welcome.",
          title: "Leave a little room for messy.", description: "Works in progress, happy accidents, and fresh pages.",
          messages: [
            { who: "june", time: "2:03 PM", text: "Tried drawing the same little house ten different ways. The wonkiest one is somehow my favorite." },
            { who: "mia", time: "2:06 PM", text: "The wonky ones always have the most personality. Does it have a tiny chimney?" },
            { who: "june", time: "2:07 PM", text: "Two! Structurally questionable. Emotionally necessary." },
          ],
        },
        {
          id: "slow-sundays", name: "slow-sundays", topic: "No rush. No agenda.",
          title: "Nothing on the calendar.", description: "Small joys and very unambitious plans.",
          messages: [
            { who: "leo", time: "10:24 AM", text: "Today’s plan: the bakery, a long walk, maybe absolutely nothing else." },
            { who: "mia", time: "10:31 AM", text: "Reporting in from the sofa with a book I’ve been meaning to finish for six months." },
            { who: "june", time: "10:35 AM", text: "An excellent pace. I’m still on the first coffee." },
          ],
        },
      ],
    },
    {
      name: "Studio Hours", symbol: "◒", description: "A shared table for curious minds.",
      channels: [
        {
          id: "inspiration", name: "inspiration", topic: "Keep the things that catch your eye.",
          title: "Ideas come from everywhere.", description: "An open notebook for the things you notice.",
          messages: [
            { who: "mia", time: "11:02 AM", text: "The flower shop down the street has the best hand-painted lettering. Took the long way home just to look again." },
            { who: "june", time: "11:09 AM", text: "I love a sign where you can still see the brush strokes." },
            { who: "leo", time: "11:12 AM", text: "My camera roll is 80% old signs and interesting chairs at this point." },
          ],
        },
        {
          id: "the-worktable", name: "the-worktable", topic: "What are you making?",
          title: "Something from almost nothing.", description: "Make a start. Share a thought. See where it goes.",
          messages: [
            { who: "june", time: "3:20 PM", text: "Making a tiny zine about all the plants I’ve managed to keep alive." },
            { who: "leo", time: "3:22 PM", text: "Mine would be a very short zine." },
            { who: "mia", time: "3:26 PM", text: "One page is still a publication. I believe in you and your cactus." },
          ],
        },
      ],
    },
    {
      name: "Afterglow", symbol: "☼", description: "For the hours after the world slows down.",
      channels: [
        {
          id: "late-night", name: "late-night", topic: "One more thought before sleep.",
          title: "The lights are still on.", description: "Quiet company for the night owls.",
          messages: [
            { who: "leo", time: "11:41 PM", text: "Just walked home under the clearest sky. I always forget how many stars are actually up there." },
            { who: "june", time: "11:44 PM", text: "Opening the window for a look. Thanks for the reminder." },
            { who: "mia", time: "11:48 PM", text: "A good note to end the day on. Night, everyone 🌙" },
          ],
        },
      ],
    },
  ];
  let serverIndex = 0;
  let currentChannel = servers[0].channels[0];
  const drafts = new Map();
  const localMessages = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function announce(text) {
    $("#announcer").textContent = text;
  }

  function showPage(page, focus = true) {
    app.dataset.view = page;
    $("#chat-page").hidden = page === "korg";
    $("#korg-page").hidden = page !== "korg";
    if (page === "chats") resizeInput();
    document.querySelectorAll("[data-page]").forEach((button) => {
      if (button.dataset.page === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (focus) {
      const target = page === "korg" ? "#korg-title" : page === "servers" ? "#server-name" : "#chat-title";
      $(target).focus({ preventScroll: true });
    }
  }

  function renderServers() {
    const container = $("#server-buttons");
    container.replaceChildren();
    servers.forEach((server, index) => {
      const button = element("button", "server-button", server.symbol);
      button.type = "button";
      button.title = server.name;
      button.setAttribute("aria-label", `${server.name} sample server`);
      button.setAttribute("aria-pressed", String(index === serverIndex));
      button.addEventListener("click", () => {
        drafts.set(currentChannel.id, input.value);
        serverIndex = index;
        currentChannel = server.channels[0];
        renderServers();
        renderChannels();
        renderChat();
        showPage("servers");
        announce(`${server.name}. ${server.channels.length} sample channels.`);
      });
      container.append(button);
    });
  }

  function renderChannels() {
    const server = servers[serverIndex];
    $("#server-name").textContent = server.name;
    $("#server-description").textContent = server.description;
    $("#channel-count").textContent = String(server.channels.length);
    const container = $("#channel-list");
    container.replaceChildren();
    server.channels.forEach((channel) => {
      const button = element("button", "channel-button");
      button.type = "button";
      const hash = element("span", "channel-hash", "#");
      hash.setAttribute("aria-hidden", "true");
      button.append(hash, element("span", "", channel.name));
      if (channel === currentChannel) {
        button.setAttribute("aria-current", "page");
        const dot = element("span", "channel-dot");
        dot.setAttribute("aria-hidden", "true");
        button.append(dot);
      }
      button.addEventListener("click", () => {
        drafts.set(currentChannel.id, input.value);
        currentChannel = channel;
        renderChannels();
        renderChat();
        showPage("chats");
      });
      container.append(button);
    });
  }

  function messageNode(message) {
    const person = people[message.who];
    const row = element("article", "message");
    row.setAttribute("role", "listitem");
    const avatar = element("span", `avatar ${person.color}`, person.initials);
    avatar.setAttribute("aria-hidden", "true");
    const body = element("div", "message-body");
    const meta = element("div", "message-meta");
    meta.append(element("strong", "", person.name), element("span", "", message.time));
    body.append(meta, element("p", "", message.text));
    if (message.record) {
      const card = element("div", "record-card");
      const art = element("div", "record-art");
      art.setAttribute("aria-hidden", "true");
      const details = element("div");
      details.append(element("small", "", "FROM THE RECORD SHELF"), element("strong", "", "Moon Safari"), element("p", "", "Air · 1998"));
      card.append(art, details);
      body.append(card);
    }
    row.append(avatar, body);
    return row;
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 125)}px`;
    sendButton.disabled = !input.value.trim();
  }

  function renderChat() {
    $("#chat-title").textContent = currentChannel.name;
    $("#chat-topic").textContent = currentChannel.topic;
    $("#welcome-title").textContent = currentChannel.title;
    $("#welcome-description").textContent = currentChannel.description;
    $("#messages").replaceChildren(...currentChannel.messages.map(messageNode), ...(localMessages.get(currentChannel.id) || []).map(messageNode));
    input.value = drafts.get(currentChannel.id) || "";
    resizeInput();
    conversation.scrollTop = 0;
  }

  function applyTheme(theme, persist = false) {
    if (!Object.hasOwn(themeNames, theme)) return;
    document.documentElement.dataset.theme = theme;
    $("meta[name='theme-color']").content = themeColors[theme];
    document.querySelectorAll("input[name='theme']").forEach((radio) => { radio.checked = radio.value === theme; });
    if (persist) {
      let notice;
      try {
        localStorage.setItem(storageKey, theme);
        notice = `${themeNames[theme]} applied to this preview. Saved on this browser.`;
      } catch {
        notice = `${themeNames[theme]} applied for this visit. Browser storage is unavailable.`;
      }
      $("#theme-notice").textContent = notice;
      announce(notice);
    }
  }

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && Object.hasOwn(themeNames, saved)) applyTheme(saved);
  } catch {
    $("#theme-notice").textContent = "Themes work for this visit. Browser storage is unavailable.";
  }
  document.querySelectorAll("input[name='theme']").forEach((radio) => {
    radio.addEventListener("change", () => applyTheme(radio.value, true));
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });
  $("#customize-button").addEventListener("click", () => showPage("korg"));
  input.addEventListener("input", () => {
    drafts.set(currentChannel.id, input.value);
    resizeInput();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("#message-form").requestSubmit();
    }
  });
  $("#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim().slice(0, 2000);
    if (!text) return;
    const message = { who: "you", time: "Local sample · not sent to Discord", text };
    const messages = localMessages.get(currentChannel.id) || [];
    messages.push(message);
    localMessages.set(currentChannel.id, messages);
    $("#messages").append(messageNode(message));
    input.value = "";
    drafts.delete(currentChannel.id);
    resizeInput();
    conversation.scrollTop = conversation.scrollHeight;
    input.focus({ preventScroll: true });
    announce("Sample message added locally. Not sent to Discord. It will clear when this page reloads.");
  });

  renderServers();
  renderChannels();
  renderChat();
})();
