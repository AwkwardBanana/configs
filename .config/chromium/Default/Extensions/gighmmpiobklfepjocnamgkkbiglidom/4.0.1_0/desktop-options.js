/* eslint-disable */(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

function send(type, args)
{
  args = Object.assign({}, {type}, args);
  return browser.runtime.sendMessage(args);
}

const app = {
  get: (what) => send("app.get", {what}),
  open: (what) => send("app.open", {what})
};
module.exports.app = app;

const doclinks = {
  get: (link) => send("app.get", {what: "doclink", link})
};
module.exports.doclinks = doclinks;

// For now we are merely reusing the port for long-lived communications to fix
// https://gitlab.com/eyeo/adblockplus/abpui/adblockplusui/issues/415
const port = browser.runtime.connect({name: "ui"});
module.exports.port = port;

},{}],2:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/* globals checkShareResource, getDocLink, i18nFormatDateTime, openSharePopup,
  E */

"use strict";

require("./io-filter-table");
require("./io-list-box");
require("./io-popout");
require("./io-toggle");

const api = require("./api");
const {$, events} = require("./dom");

const {port} = api;

let subscriptionsMap = Object.create(null);
let filtersMap = Object.create(null);
let acceptableAdsUrl = null;
let acceptableAdsPrivacyUrl = null;
let isCustomFiltersLoaded = false;
let additionalSubscriptions = [];
let languages = {};

const collections = Object.create(null);
const {getMessage} = browser.i18n;
const {setElementLinks, setElementText} = ext.i18n;
const customFilters = [];
const filterErrors = new Map([
  ["synchronize_invalid_url",
   "options_filterList_lastDownload_invalidURL"],
  ["synchronize_connection_error",
   "options_filterList_lastDownload_connectionError"],
  ["synchronize_invalid_data",
   "options_filterList_lastDownload_invalidData"],
  ["synchronize_checksum_mismatch",
   "options_filterList_lastDownload_checksumMismatch"]
]);
const timestampUI = Symbol();
const whitelistedDomainRegexp = /^@@\|\|([^/:]+)\^\$document$/;
// Period of time in milliseconds
const minuteInMs = 60000;
const hourInMs = 3600000;
const fullDayInMs = 86400000;

const promisedLocaleInfo = browser.runtime.sendMessage({type: "app.get",
  what: "localeInfo"});
const promisedDateFormat = promisedLocaleInfo.then((addonLocale) =>
{
  return new Intl.DateTimeFormat(addonLocale.locale);
});
const promisedRecommendationsLoaded = loadRecommendations();

function Collection(details)
{
  this.details = details;
  this.items = [];
}

Collection.prototype._setEmpty = function(table, detail, removeEmpty)
{
  if (removeEmpty)
  {
    const placeholders = table.querySelectorAll(".empty-placeholder");
    for (const placeholder of placeholders)
      table.removeChild(placeholder);

    execAction(detail.removeEmptyAction, table);
  }
  else
  {
    const {emptyTexts = []} = detail;
    for (const text of emptyTexts)
    {
      const placeholder = document.createElement("li");
      placeholder.className = "empty-placeholder";
      placeholder.textContent = getMessage(text);
      table.appendChild(placeholder);
    }

    execAction(detail.setEmptyAction, table);
  }
};

Collection.prototype._createElementQuery = function(item)
{
  const access = (item.url || item.text).replace(/'/g, "\\'");
  return function(container)
  {
    return container.querySelector("[data-access='" + access + "']");
  };
};

Collection.prototype._getItemTitle = function(item, i)
{
  if (this.details[i].getTitleFunction)
    return this.details[i].getTitleFunction(item);
  return item.title || item.url || item.text;
};

Collection.prototype._sortItems = function()
{
  this.items.sort((a, b) =>
  {
    // Make sure that Acceptable Ads is always last, since it cannot be
    // disabled, but only be removed. That way it's grouped together with
    // the "Own filter list" which cannot be disabled either at the bottom
    // of the filter lists in the Advanced tab.
    if (a.url && isAcceptableAds(a.url))
      return 1;
    if (b.url && isAcceptableAds(b.url))
      return -1;

    // Make sure that newly added entries always appear on top in descending
    // chronological order
    const aTimestamp = a[timestampUI] || 0;
    const bTimestamp = b[timestampUI] || 0;
    if (aTimestamp || bTimestamp)
      return bTimestamp - aTimestamp;

    const aTitle = this._getItemTitle(a, 0).toLowerCase();
    const bTitle = this._getItemTitle(b, 0).toLowerCase();
    return aTitle.localeCompare(bTitle);
  });
};

Collection.prototype.addItem = function(item)
{
  if (this.items.indexOf(item) >= 0)
    return;

  this.items.push(item);
  this._sortItems();
  for (let j = 0; j < this.details.length; j++)
  {
    const detail = this.details[j];
    const table = $(`#${detail.id}`);
    const template = table.querySelector("template");
    const listItem = document.createElement("li");
    listItem.appendChild(document.importNode(template.content, true));
    listItem.setAttribute("aria-label", this._getItemTitle(item, j));
    listItem.setAttribute("data-access", item.url || item.text);
    listItem.setAttribute("role", "section");

    const tooltip = listItem.querySelector("io-popout[type='tooltip']");
    if (tooltip)
    {
      let tooltipId = tooltip.getAttribute("i18n-body");
      tooltipId = tooltipId.replace("%value%", item.recommended);
      if (getMessage(tooltipId))
      {
        tooltip.setAttribute("i18n-body", tooltipId);
      }
    }

    for (const control of listItem.querySelectorAll(".control"))
    {
      if (control.hasAttribute("title"))
      {
        const titleValue = getMessage(control.getAttribute("title"));
        control.setAttribute("title", titleValue);
      }
    }

    this._setEmpty(table, detail, true);
    if (table.children.length > 0)
      table.insertBefore(listItem, table.children[this.items.indexOf(item)]);
    else
      table.appendChild(listItem);

    this.updateItem(item);
  }
  return length;
};

Collection.prototype.removeItem = function(item)
{
  const index = this.items.indexOf(item);
  if (index == -1)
    return;

  this.items.splice(index, 1);
  const getListElement = this._createElementQuery(item);
  for (const detail of this.details)
  {
    const table = $(`#${detail.id}`);
    const element = getListElement(table);

    // Element gets removed so make sure to handle focus appropriately
    const control = element.querySelector(".control");
    if (control && control == document.activeElement)
    {
      if (!focusNextElement(element.parentElement, control))
      {
        // Fall back to next focusable element within same tab or dialog
        let focusableElement = element.parentElement;
        while (focusableElement)
        {
          if (focusableElement.classList.contains("tab-content") ||
              focusableElement.classList.contains("dialog-content"))
            break;

          focusableElement = focusableElement.parentElement;
        }
        focusNextElement(focusableElement || document, control);
      }
    }

    element.parentElement.removeChild(element);
    if (this.items.length == 0)
      this._setEmpty(table, detail);
  }
};

Collection.prototype.updateItem = function(item)
{
  const oldIndex = this.items.indexOf(item);
  this._sortItems();
  const access = (item.url || item.text).replace(/'/g, "\\'");
  for (let i = 0; i < this.details.length; i++)
  {
    const table = $(`#${this.details[i].id}`);
    const element = table.querySelector("[data-access='" + access + "']");
    if (!element)
      continue;

    const title = this._getItemTitle(item, i);
    const displays = element.querySelectorAll("[data-display]");
    for (let j = 0; j < displays.length; j++)
    {
      if (item[displays[j].dataset.display])
        displays[j].textContent = item[displays[j].dataset.display];
      else
        displays[j].textContent = title;
    }

    element.setAttribute("aria-label", title);
    if (this.details[i].searchable)
      element.setAttribute("data-search", title.toLowerCase());
    const controls = element.querySelectorAll(".control[role='checkbox']");
    for (const control of controls)
    {
      control.setAttribute("aria-checked", item.disabled == false);
      if (isAcceptableAds(item.url) && this == collections.filterLists)
        control.disabled = !item.disabled;
    }
    if (additionalSubscriptions.includes(item.url))
    {
      element.classList.add("preconfigured");
      const disablePreconfigures =
        element.querySelectorAll("[data-disable~='preconfigured']");
      for (const disablePreconfigure of disablePreconfigures)
        disablePreconfigure.disabled = true;
    }

    const lastUpdateElement = element.querySelector(".last-update");
    if (lastUpdateElement)
    {
      const message = element.querySelector(".message");
      if (item.downloading)
      {
        const text = getMessage("options_filterList_lastDownload_inProgress");
        message.textContent = text;
        element.classList.add("show-message");
      }
      else if (item.downloadStatus != "synchronize_ok")
      {
        const error = filterErrors.get(item.downloadStatus);
        if (error)
          message.textContent = getMessage(error);
        else
          message.textContent = item.downloadStatus;
        element.classList.add("show-message");
      }
      else if (item.lastDownload > 0)
      {
        const lastUpdate = item.lastDownload * 1000;
        const sinceUpdate = Date.now() - lastUpdate;
        if (sinceUpdate > fullDayInMs)
        {
          const lastUpdateDate = new Date(item.lastDownload * 1000);
          promisedDateFormat.then((dateFormat) =>
          {
            lastUpdateElement.textContent = dateFormat.format(lastUpdateDate);
          });
        }
        else if (sinceUpdate > hourInMs)
        {
          lastUpdateElement.textContent =
            getMessage("options_filterList_hours");
        }
        else if (sinceUpdate > minuteInMs)
        {
          lastUpdateElement.textContent =
            getMessage("options_filterList_minutes");
        }
        else
        {
          lastUpdateElement.textContent =
            getMessage("options_filterList_now");
        }
        element.classList.remove("show-message");
      }
    }

    const websiteElement = element.querySelector("io-popout .website");
    if (websiteElement)
    {
      if (item.homepage)
        websiteElement.setAttribute("href", item.homepage);
      websiteElement.setAttribute("aria-hidden", !item.homepage);
    }

    const sourceElement = element.querySelector("io-popout .source");
    if (sourceElement)
      sourceElement.setAttribute("href", item.url);

    const newIndex = this.items.indexOf(item);
    if (oldIndex != newIndex)
      table.insertBefore(element, table.childNodes[newIndex]);
  }
};

Collection.prototype.clearAll = function()
{
  this.items = [];
  for (const detail of this.details)
  {
    const table = $(`#${detail.id}`);
    let element = table.firstChild;
    while (element)
    {
      if (element.tagName == "LI" && !element.classList.contains("static"))
        table.removeChild(element);
      element = element.nextElementSibling;
    }

    this._setEmpty(table, detail);
  }
};

function focusNextElement(container, currentElement)
{
  let focusables = container.querySelectorAll("a, button, input, .control");
  focusables = Array.prototype.slice.call(focusables);
  let index = focusables.indexOf(currentElement);
  index += (index == focusables.length - 1) ? -1 : 1;

  const nextElement = focusables[index];
  if (!nextElement)
    return false;

  nextElement.focus();
  return true;
}

collections.cv = new Collection([
  {
    id: "anti-cv-table"
  }
]);
collections.protection = new Collection([
  {
    id: "recommend-protection-list-table"
  }
]);
collections.langs = new Collection([
  {
    id: "blocking-languages-table",
    emptyTexts: ["options_language_empty"],
    getTitleFunction: getLanguageTitle
  }
]);
collections.allLangs = new Collection([
  {
    id: "all-lang-table-add",
    emptyTexts: ["options_dialog_language_other_empty"],
    getTitleFunction: getLanguageTitle
  }
]);
collections.more = new Collection([
  {
    id: "more-list-table",
    setEmptyAction: "hide-more-filters-section",
    removeEmptyAction: "show-more-filters-section"
  }
]);
collections.whitelist = new Collection([
  {
    id: "whitelisting-table",
    emptyTexts: ["options_whitelist_empty_1", "options_whitelist_empty_2"]
  }
]);
collections.filterLists = new Collection([
  {
    id: "all-filter-lists-table",
    emptyTexts: ["options_filterList_empty"],
    getTitleFunction: (item) => item.originalTitle || item.title || item.url
  }
]);

function addSubscription(subscription)
{
  const {disabled, recommended, url} = subscription;
  let collection = null;
  if (recommended)
  {
    if (recommended == "ads")
    {
      if (disabled == false)
        collection = collections.langs;

      collections.allLangs.addItem(subscription);
    }
    else if (recommended == "circumvention")
    {
      collection = collections.cv;
    }
    else
    {
      collection = collections.protection;
    }
  }
  else if (!isAcceptableAds(url) && disabled == false)
  {
    collection = collections.more;
  }

  if (collection)
    collection.addItem(subscription);

  subscriptionsMap[url] = subscription;
}

function updateSubscription(subscription)
{
  for (const name in collections)
    collections[name].updateItem(subscription);

  if (subscription.recommended == "ads")
  {
    if (subscription.disabled)
      collections.langs.removeItem(subscription);
    else
      collections.langs.addItem(subscription);
  }
  else if (!subscription.recommended && !isAcceptableAds(subscription.url))
  {
    if (subscription.disabled == false)
    {
      collections.more.addItem(subscription);
    }
    else
    {
      collections.more.removeItem(subscription);
    }
  }

  if (!(subscription.url in subscriptionsMap))
  {
    subscriptionsMap[subscription.url] = subscription;
  }
}

function updateFilter(filter)
{
  const match = filter.text.match(whitelistedDomainRegexp);
  if (match && !filtersMap[filter.text])
  {
    filter.title = match[1];
    collections.whitelist.addItem(filter);
    if (isCustomFiltersLoaded)
    {
      const text = getMessage("options_whitelist_notification", [filter.title]);
      showNotification(text);
    }
  }
  else
  {
    customFilters.push(filter);
  }

  filtersMap[filter.text] = filter;
}

function loadCustomFilters(filters)
{
  for (const filter of filters)
    updateFilter(filter);

  const cfTable = $("#custom-filters io-filter-table");
  cfTable.filters = customFilters;
}

function removeCustomFilter(text)
{
  const index = customFilters.findIndex(filter => filter.text === text);
  if (index >= 0)
    customFilters.splice(index, 1);
}

function getLanguageTitle(item)
{
  const langs = item.languages.slice();
  const firstLang = langs.shift();
  let title = langs.reduce((acc, lang) =>
  {
    return getMessage("options_language_join", [acc, languages[lang]]);
  }, languages[firstLang]);
  if (item.originalTitle && item.originalTitle.indexOf("+EasyList") > -1)
    title += " + " + getMessage("options_english");
  return title;
}

function loadRecommendations()
{
  return Promise.all([
    fetch("data/languages.json").then((resp) => resp.json()),
    api.app.get("recommendations")
  ]).then(([languagesData, recommendations]) =>
  {
    languages = languagesData;

    for (const recommendation of recommendations)
    {
      let {type} = recommendation;
      const subscription = {
        disabled: true,
        downloadStatus: null,
        homepage: null,
        originalTitle: recommendation.title,
        languages: recommendation.languages,
        recommended: type,
        url: recommendation.url
      };

      if (subscription.recommended != "ads" &&
          subscription.recommended != "circumvention")
      {
        type = type.replace(/\W/g, "_");
        subscription.title = getMessage(`common_feature_${type}_title`);
      }

      addSubscription(subscription);
    }
  });
}

function findParentData(element, dataName, returnElement)
{
  element = element.closest(`[data-${dataName}]`);
  if (!element)
    return null;
  if (returnElement)
    return element;
  return element.getAttribute(`data-${dataName}`);
}

function sendMessageHandleErrors(message, onSuccess)
{
  browser.runtime.sendMessage(message).then(errors =>
  {
    if (errors.length > 0)
      alert(errors.join("\n"));
    else if (onSuccess)
      onSuccess();
  });
}

function switchTab(id)
{
  location.hash = id;
}

function execAction(action, element)
{
  if (element.getAttribute("aria-disabled") == "true")
    return;

  switch (action)
  {
    case "add-domain-exception":
      addWhitelistedDomain();
      break;
    case "add-language-subscription":
      addEnableSubscription(findParentData(element, "access", false));
      break;
    case "add-predefined-subscription": {
      const dialog = $("#dialog-content-predefined");
      const title = dialog.querySelector("h3").textContent;
      const url = dialog.querySelector(".url").textContent;
      addEnableSubscription(url, title);
      closeDialog();
      break;
    }
    case "change-language-subscription":
      changeLanguageSubscription(findParentData(element, "access", false));
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "hide-more-filters-section":
      $("#more-filters").setAttribute("aria-hidden", true);
      break;
    case "hide-notification":
      hideNotification();
      break;
    case "import-subscription": {
      const url = $("#blockingList-textbox").value;
      addEnableSubscription(url);
      closeDialog();
      break;
    }
    case "open-dialog": {
      const dialog = findParentData(element, "dialog", false);
      openDialog(dialog);
      break;
    }
    case "open-list-box":
      const ioListBox = $("io-list-box");
      ioListBox.change = true;
      $("button", ioListBox).focus();
      break;
    case "remove-filter":
      browser.runtime.sendMessage({
        type: "filters.remove",
        text: findParentData(element, "access", false)
      });
      break;
    case "remove-subscription":
      browser.runtime.sendMessage({
        type: "subscriptions.remove",
        url: findParentData(element, "access", false)
      });
      break;
    case "show-more-filters-section":
      $("#more-filters").setAttribute("aria-hidden", false);
      break;
    case "switch-acceptable-ads":
      const value = element.value || element.dataset.value;
      // User check the checkbox
      const shouldCheck = element.getAttribute("aria-checked") != "true";
      let installAcceptableAds = false;
      let installAcceptableAdsPrivacy = false;
      // Acceptable Ads checkbox clicked
      if (value == "ads")
      {
        installAcceptableAds = shouldCheck;
      }
      // Privacy Friendly Acceptable Ads checkbox clicked
      else
      {
        installAcceptableAdsPrivacy = shouldCheck;
        installAcceptableAds = !shouldCheck;
      }

      browser.runtime.sendMessage({
        type: installAcceptableAds ? "subscriptions.add" :
          "subscriptions.remove",
        url: acceptableAdsUrl
      });
      browser.runtime.sendMessage({
        type: installAcceptableAdsPrivacy ? "subscriptions.add" :
          "subscriptions.remove",
        url: acceptableAdsPrivacyUrl
      });
      break;
    case "switch-tab":
      switchTab(element.getAttribute("href").substr(1));
      break;
    case "toggle-disable-subscription":
      browser.runtime.sendMessage({
        type: "subscriptions.toggle",
        keepInstalled: true,
        url: findParentData(element, "access", false)
      });
      break;
    case "toggle-pref":
      browser.runtime.sendMessage({
        type: "prefs.toggle",
        key: findParentData(element, "pref", false)
      });
      break;
    case "toggle-remove-subscription":
      const subscriptionUrl = findParentData(element, "access", false);
      if (element.getAttribute("aria-checked") == "true")
      {
        browser.runtime.sendMessage({
          type: "subscriptions.remove",
          url: subscriptionUrl
        });
      }
      else
        addEnableSubscription(subscriptionUrl);
      break;
    case "update-all-subscriptions":
      browser.runtime.sendMessage({
        type: "subscriptions.update"
      });
      break;
    case "update-subscription":
      browser.runtime.sendMessage({
        type: "subscriptions.update",
        url: findParentData(element, "access", false)
      });
      break;
    case "validate-import-subscription":
      const form = findParentData(element, "validation", true);
      if (!form)
        return;

      if (form.checkValidity())
      {
        addEnableSubscription($("#import-list-url").value);
        form.reset();
        closeDialog();
      }
      else
      {
        form.querySelector(":invalid").focus();
      }
      break;
  }
}

function changeLanguageSubscription(url)
{
  for (const key in subscriptionsMap)
  {
    const subscription = subscriptionsMap[key];
    const subscriptionType = subscription.recommended;
    if (subscriptionType == "ads" && subscription.disabled == false)
    {
      browser.runtime.sendMessage({
        type: "subscriptions.remove",
        url: subscription.url
      });
      browser.runtime.sendMessage({
        type: "subscriptions.add",
        url
      });
      break;
    }
  }
}

function onClick(e)
{
  let actions = findParentData(e.target, "action", false);
  if (!actions)
    return;

  actions = actions.split(",");
  for (const action of actions)
  {
    execAction(action, e.target);
  }
}

function onKeyUp(e)
{
  const key = events.key(e);
  let element = document.activeElement;
  if (!key || !element)
    return;

  const container = findParentData(element, "action", true);
  if (!container || !container.hasAttribute("data-keys"))
    return;

  const keys = container.getAttribute("data-keys").split(" ");
  if (keys.indexOf(key) < 0)
    return;

  if (element.getAttribute("role") == "tab")
  {
    let parent = element.parentElement;
    if (key == "ArrowLeft" || key == "ArrowUp")
      parent = parent.previousElementSibling || container.lastElementChild;
    else if (key == "ArrowRight" || key == "ArrowDown")
      parent = parent.nextElementSibling || container.firstElementChild;
    element = parent.firstElementChild;
  }

  const actions = container.getAttribute("data-action").split(",");
  for (const action of actions)
  {
    execAction(action, element);
  }
}

function selectTabItem(tabId, container, focus)
{
  // Show tab content
  document.body.setAttribute("data-tab", tabId);

  // Select tab
  const tabList = container.querySelector("[role='tablist']");
  if (!tabList)
    return null;

  const previousTab = tabList.querySelector("[aria-selected]");
  previousTab.removeAttribute("aria-selected");
  previousTab.setAttribute("tabindex", -1);

  const tab = tabList.querySelector("a[href='#" + tabId + "']");
  tab.setAttribute("aria-selected", true);
  tab.setAttribute("tabindex", 0);

  const tabContentId = tab.getAttribute("aria-controls");
  const tabContent = document.getElementById(tabContentId);

  if (tab && focus)
    tab.focus();

  return tabContent;
}

function onHashChange()
{
  const hash = location.hash.substr(1);
  if (!hash)
    return;

  // Select tab and parent tabs
  const tabIds = hash.split("-");
  let tabContent = document.body;
  for (let i = 0; i < tabIds.length; i++)
  {
    const tabId = tabIds.slice(0, i + 1).join("-");
    tabContent = selectTabItem(tabId, tabContent, true);
    if (!tabContent)
      break;
  }
}

function setupIoListBox()
{
  const ioListBox = $("io-list-box");
  ioListBox.getItemTitle = getLanguageTitle;
  ioListBox.placeholder = getMessage("options_dialog_language_title");
  ioListBox.items = collections.allLangs.items;
  ioListBox.addEventListener("close", (event) =>
  {
    ioListBox.change = false;
  });
  ioListBox.addEventListener("change", (event) =>
  {
    const item = event.detail;
    if (ioListBox.change)
      changeLanguageSubscription(item.url);
    else
    {
      item.disabled = !item.disabled;
      addEnableSubscription(item.url, item.originalTitle, item.homepage);
    }
  });
}

function onDOMLoaded()
{
  populateLists().then(setupIoListBox);

  // Initialize navigation sidebar
  browser.runtime.sendMessage({
    type: "app.get",
    what: "addonVersion"
  }).then(addonVersion =>
  {
    $("#abp-version").textContent = getMessage("options_dialog_about_version",
      [addonVersion]);
  });

  // Initialize interactive UI elements
  document.body.addEventListener("click", onClick, false);
  document.body.addEventListener("keyup", onKeyUp, false);
  const exampleValue = getMessage("options_whitelist_placeholder_example",
    ["www.example.com"]);
  $("#whitelisting-textbox").setAttribute("placeholder", exampleValue);
  $("#whitelisting-textbox").addEventListener("keyup", (e) =>
  {
    $("#whitelisting-add-button").disabled = !e.target.value;
  }, false);

  // General tab
  getDocLink("contribute").then(link =>
  {
    $("#contribute").href = link;
  });
  getDocLink("acceptable_ads_criteria").then(link =>
  {
    setElementLinks("enable-acceptable-ads-description", link);
  });
  getDocLink("imprint").then((url) =>
  {
    setElementText(
      $("#copyright"),
      "options_dialog_about_copyright",
      [new Date().getFullYear()]
    );
    setElementLinks("copyright", url);
  });
  getDocLink("privacy").then((url) =>
  {
    $("#privacy-policy").href = url;
  });
  setElementText($("#tracking-warning-1"), "options_tracking_warning_1",
    [getMessage("common_feature_privacy_title"),
     getMessage("options_acceptableAds_ads_label")]);
  setElementText($("#tracking-warning-3"), "options_tracking_warning_3",
    [getMessage("options_acceptableAds_privacy_label")]);

  getDocLink("privacy_friendly_ads").then(link =>
  {
    $("#enable-acceptable-ads-privacy-description").href = link;
  });
  getDocLink("adblock_plus_{browser}_dnt").then(url =>
  {
    setElementLinks("dnt", url);
  });

  // Whitelisted tab
  getDocLink("whitelist").then(link =>
  {
    $("#whitelist-learn-more").href = link;
  });

  // Advanced tab
  let customize = document.querySelectorAll("#customize li[data-pref]");
  customize = Array.prototype.map.call(customize, (checkbox) =>
  {
    return checkbox.getAttribute("data-pref");
  });
  for (const key of customize)
  {
    getPref(key).then((value) =>
    {
      onPrefMessage(key, value, true);
    });
  }
  browser.runtime.sendMessage({
    type: "app.get",
    what: "features"
  }).then(features =>
  {
    hidePref("show_devtools_panel", !features.devToolsPanel);
  });

  getDocLink("filterdoc").then(link =>
  {
    setElementLinks("custom-filters-description", link);
  });

  getDocLink("subscriptions").then(link =>
  {
    $("#filter-lists-learn-more").setAttribute("href", link);
  });

  // Help tab
  getDocLink("adblock_plus_report_bug").then(link =>
  {
    setElementLinks("report-bug", link);
  });
  getDocLink("{browser}_support").then(url =>
  {
    setElementLinks("visit-forum", url);
  });
  getDocLink("social_twitter").then(link =>
  {
    $("#social .twitter").setAttribute("href", link);
  });
  getDocLink("social_facebook").then(link =>
  {
    $("#social .facebook").setAttribute("href", link);
  });
  getDocLink("social_weibo").then(link =>
  {
    $("#social .weibo").setAttribute("href", link);
  });

  $("#dialog").addEventListener("keydown", function(e)
  {
    switch (events.key(e))
    {
      case "Escape":
        closeDialog();
        break;
      case "Tab":
        if (e.shiftKey)
        {
          if (e.target.classList.contains("focus-first"))
          {
            e.preventDefault();
            this.querySelector(".focus-last").focus();
          }
        }
        else if (e.target.classList.contains("focus-last"))
        {
          e.preventDefault();
          this.querySelector(".focus-first").focus();
        }
        break;
    }
  }, false);

  onHashChange();
}

let focusedBeforeDialog = null;
function openDialog(name)
{
  const dialog = $("#dialog");
  dialog.setAttribute("aria-hidden", false);
  dialog.setAttribute("aria-labelledby", "dialog-title-" + name);
  document.body.setAttribute("data-dialog", name);

  let defaultFocus = document.querySelector(
    "#dialog-content-" + name + " .default-focus"
  );
  if (!defaultFocus)
    defaultFocus = dialog.querySelector(".focus-first");
  focusedBeforeDialog = document.activeElement;
  defaultFocus.focus();
}

function closeDialog()
{
  const dialog = $("#dialog");
  dialog.setAttribute("aria-hidden", true);
  dialog.removeAttribute("aria-labelledby");
  document.body.removeAttribute("data-dialog");
  focusedBeforeDialog.focus();
}

function showNotification(text)
{
  $("#notification").setAttribute("aria-hidden", false);
  $("#notification-text").textContent = text;
  setTimeout(hideNotification, 3000);
}

function hideNotification()
{
  $("#notification").setAttribute("aria-hidden", true);
  $("#notification-text").textContent = "";
}

function setAcceptableAds()
{
  const acceptableAdsForm = $("#acceptable-ads");
  const acceptableAds = $("#acceptable-ads-allow");
  const acceptableAdsPrivacy = $("#acceptable-ads-privacy-allow");
  acceptableAdsForm.classList.remove("show-dnt-notification");
  acceptableAds.setAttribute("aria-checked", false);
  acceptableAdsPrivacy.setAttribute("aria-checked", false);
  acceptableAdsPrivacy.setAttribute("tabindex", 0);
  if (acceptableAdsUrl in subscriptionsMap &&
      !subscriptionsMap[acceptableAdsUrl].disabled)
  {
    acceptableAds.setAttribute("aria-checked", true);
    acceptableAdsPrivacy.setAttribute("aria-disabled", false);
  }
  else if (acceptableAdsPrivacyUrl in subscriptionsMap &&
          !subscriptionsMap[acceptableAdsPrivacyUrl].disabled)
  {
    acceptableAds.setAttribute("aria-checked", true);
    acceptableAdsPrivacy.setAttribute("aria-checked", true);
    acceptableAdsPrivacy.setAttribute("aria-disabled", false);

    // Edge uses window instead of navigator.
    // Prefer navigator first since it's the standard.
    if ((navigator.doNotTrack || window.doNotTrack) != 1)
      acceptableAdsForm.classList.add("show-dnt-notification");
  }
  else
  {
    // Using aria-disabled in order to keep the focus
    acceptableAdsPrivacy.setAttribute("aria-disabled", true);
    acceptableAdsPrivacy.setAttribute("tabindex", -1);
  }
}

function isAcceptableAds(url)
{
  return url == acceptableAdsUrl || url == acceptableAdsPrivacyUrl;
}

function hasPrivacyConflict()
{
  const acceptableAdsList = subscriptionsMap[acceptableAdsUrl];
  let privacyList = null;
  for (const url in subscriptionsMap)
  {
    const subscription = subscriptionsMap[url];
    if (subscription.recommended == "privacy")
    {
      privacyList = subscription;
      break;
    }
  }
  return acceptableAdsList && acceptableAdsList.disabled == false &&
    privacyList && privacyList.disabled == false;
}

function setPrivacyConflict()
{
  const acceptableAdsForm = $("#acceptable-ads");
  if (hasPrivacyConflict())
  {
    getPref("ui_warn_tracking").then((showTrackingWarning) =>
    {
      acceptableAdsForm.classList.toggle("show-warning", showTrackingWarning);
    });
  }
  else
  {
    acceptableAdsForm.classList.remove("show-warning");
  }
}

function populateLists()
{
  return new Promise(resolve =>
  {
    let todo = 2;
    const done = () =>
    {
      if (!--todo)
        resolve();
    };

    subscriptionsMap = Object.create(null);
    filtersMap = Object.create(null);

    // Empty collections and lists
    for (const property in collections)
      collections[property].clearAll();

    browser.runtime.sendMessage({
      type: "subscriptions.get",
      special: true
    }).then((subscriptions) =>
    {
      const customFilterPromises = subscriptions.map(getSubscriptionFilters);
      Promise.all(customFilterPromises).then((filters) =>
      {
        loadCustomFilters([].concat(...filters));
        isCustomFiltersLoaded = true;
      }).then(done);
    });

    Promise.all([
      browser.runtime.sendMessage({
        type: "prefs.get",
        key: "subscriptions_exceptionsurl"
      }),
      browser.runtime.sendMessage({
        type: "prefs.get",
        key: "subscriptions_exceptionsurl_privacy"
      }),
      getPref("additional_subscriptions"),
      browser.runtime.sendMessage({
        type: "subscriptions.get",
        downloadable: true
      })
    ])
    .then(([url, privacyUrl, additionalSubscriptionUrls, subscriptions]) =>
    {
      acceptableAdsUrl = url;
      acceptableAdsPrivacyUrl = privacyUrl;
      additionalSubscriptions = additionalSubscriptionUrls;

      for (const subscription of subscriptions)
        onSubscriptionMessage("added", subscription);

      setAcceptableAds();
      done();
    });
  });
}

function addWhitelistedDomain()
{
  const domain = $("#whitelisting-textbox");
  for (const whitelistItem of collections.whitelist.items)
  {
    if (whitelistItem.title == domain.value)
    {
      whitelistItem[timestampUI] = Date.now();
      collections.whitelist.updateItem(whitelistItem);
      domain.value = "";
      break;
    }
  }
  const value = domain.value.trim();
  if (value)
  {
    const host = /^https?:\/\//i.test(value) ? new URL(value).host : value;
    sendMessageHandleErrors({
      type: "filters.add",
      text: "@@||" + host.toLowerCase() + "^$document"
    });
  }

  domain.value = "";
  $("#whitelisting-add-button").disabled = true;
}

function addEnableSubscription(url, title, homepage)
{
  let messageType = null;
  const knownSubscription = subscriptionsMap[url];
  if (knownSubscription && knownSubscription.disabled == true)
    messageType = "subscriptions.toggle";
  else
    messageType = "subscriptions.add";

  const message = {
    type: messageType,
    url
  };
  if (title)
    message.title = title;
  if (homepage)
    message.homepage = homepage;

  browser.runtime.sendMessage(message);
}

function onFilterMessage(action, filter)
{
  switch (action)
  {
    case "added":
      filter[timestampUI] = Date.now();
      updateFilter(filter);
      break;
    case "loaded":
      populateLists();
      break;
    case "removed":
      const knownFilter = filtersMap[filter.text];
      if (whitelistedDomainRegexp.test(knownFilter.text))
        collections.whitelist.removeItem(knownFilter);
      else
        removeCustomFilter(filter.text);

      delete filtersMap[filter.text];
      break;
  }
}

function onSubscriptionMessage(action, subscription)
{
  // Ensure that recommendations have already been loaded so that we can
  // identify and handle recommended filter lists accordingly (see #6838)
  promisedRecommendationsLoaded.then(() =>
  {
    if (subscription.url in subscriptionsMap)
    {
      const knownSubscription = subscriptionsMap[subscription.url];
      for (const property in subscription)
      {
        if (property == "title" && knownSubscription.recommended)
          knownSubscription.originalTitle = subscription.title;
        else
          knownSubscription[property] = subscription[property];
      }
      subscription = knownSubscription;
    }

    switch (action)
    {
      case "disabled":
        updateSubscription(subscription);
        if (isAcceptableAds(subscription.url))
          setAcceptableAds();

        setPrivacyConflict();
        break;
      case "downloading":
      case "downloadStatus":
      case "homepage":
      case "lastDownload":
      case "title":
        updateSubscription(subscription);
        break;
      case "added":
        const {url} = subscription;
        // Handle custom subscription
        if (/^~user/.test(url))
        {
          loadCustomFilters(subscription.filters);
          return;
        }
        else if (url in subscriptionsMap)
          updateSubscription(subscription);
        else
          addSubscription(subscription);

        if (isAcceptableAds(url))
          setAcceptableAds();

        collections.filterLists.addItem(subscription);
        setPrivacyConflict();
        break;
      case "removed":
        if (subscription.recommended)
        {
          subscription.disabled = true;
          onSubscriptionMessage("disabled", subscription);
        }
        else
        {
          delete subscriptionsMap[subscription.url];
          if (isAcceptableAds(subscription.url))
          {
            setAcceptableAds();
          }
          else
          {
            collections.more.removeItem(subscription);
          }
        }

        collections.filterLists.removeItem(subscription);
        setPrivacyConflict();
        break;
    }
  });
}

function getSubscriptionFilters(subscription)
{
  return browser.runtime.sendMessage({
    type: "filters.get",
    subscriptionUrl: subscription.url});
}

function hidePref(key, value)
{
  const element = getPrefElement(key);
  if (element)
    element.setAttribute("aria-hidden", value);
}

function getPrefElement(key)
{
  return document.querySelector("[data-pref='" + key + "']");
}

function getPref(key)
{
  return browser.runtime.sendMessage({
    type: "prefs.get",
    key
  });
}

function onPrefMessage(key, value, initial)
{
  switch (key)
  {
    case "notifications_ignoredcategories":
      value = value.indexOf("*") == -1;
      break;
    case "ui_warn_tracking":
      setPrivacyConflict();
      break;
  }

  const checkbox = document.querySelector(
    "[data-pref='" + key + "'] button[role='checkbox']"
  );
  if (checkbox)
    checkbox.setAttribute("aria-checked", value);
}

port.onMessage.addListener((message) =>
{
  switch (message.type)
  {
    case "app.respond":
      switch (message.action)
      {
        case "addSubscription":
          const subscription = message.args[0];
          const dialog = $("#dialog-content-predefined");

          let {title, url} = subscription;
          if (!title || title == url)
          {
            title = "";
          }

          dialog.querySelector("h3").textContent = title;
          dialog.querySelector(".url").textContent = url;
          openDialog("predefined");
          break;
        case "focusSection":
          let section = message.args[0];
          if (section == "notifications")
          {
            section = "advanced";
            const elem = getPrefElement("notifications_ignoredcategories");
            elem.classList.add("highlight-animate");
            elem.querySelector("button").focus();
          }

          selectTabItem(section, document.body, false);
          break;
      }
      break;
    case "filters.respond":
      onFilterMessage(message.action, message.args[0]);
      break;
    case "prefs.respond":
      onPrefMessage(message.action, message.args[0], false);
      break;
    case "subscriptions.respond":
      onSubscriptionMessage(message.action, message.args[0]);
      break;
  }
});

port.postMessage({
  type: "app.listen",
  filter: ["addSubscription", "focusSection"]
});
port.postMessage({
  type: "filters.listen",
  filter: ["added", "loaded", "removed"]
});
port.postMessage({
  type: "prefs.listen",
  filter: [
    "notifications_ignoredcategories",
    "notifications_showui",
    "shouldShowBlockElementMenu",
    "show_devtools_panel",
    "show_statsinicon",
    "ui_warn_tracking"
  ]
});
port.postMessage({
  type: "subscriptions.listen",
  filter: ["added", "disabled", "homepage", "lastDownload", "removed",
           "title", "downloadStatus", "downloading"]
});

onDOMLoaded();

// We must call port.disconnect because of this Microsoft Edge bug:
// https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/19011773/
window.addEventListener("unload", () => port.disconnect());
window.addEventListener("hashchange", onHashChange, false);

},{"./api":1,"./dom":3,"./io-filter-table":8,"./io-list-box":9,"./io-popout":10,"./io-toggle":12}],3:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

let browserName = "unknown";

// Firefox only, which is exactly the one
// we are looking for in order to patch events' layerX
if (browser.runtime.getBrowserInfo)
{
  browser.runtime.getBrowserInfo().then(info =>
  {
    browserName = info.name.toLowerCase();
  });
}

// used as legacy fallback in events.key(event) via keys[event.keyCode]
const keys = {
  9: "Tab",
  13: "Enter",
  27: "Escape",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown"
};

module.exports = {
  $: (selector, container = document) => container.querySelector(selector),
  $$: (selector, container = document) => container.querySelectorAll(selector),

  // helper to format as indented string any HTML/XML node
  asIndentedString,

  // basic copy and paste clipboard utility
  clipboard: {
    // warning: Firefox needs a proper event to work
    //          such click or mousedown or similar.
    copy(text)
    {
      const selection = document.getSelection();
      const selected = selection.rangeCount > 0 ?
                        selection.getRangeAt(0) : null;
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.cssText = "position:fixed;top:-999px";
      document.body.appendChild(el).select();
      document.execCommand("copy");
      document.body.removeChild(el);
      if (selected)
      {
        selection.removeAllRanges();
        // simply putting back selected doesn't work anymore
        const range = document.createRange();
        range.setStart(selected.startContainer, selected.startOffset);
        range.setEnd(selected.endContainer, selected.endOffset);
        selection.addRange(range);
      }
    },
    // optionally accepts a `paste` DOM event
    // it uses global clipboardData, if available, otherwise.
    // i.e. input.onpaste = event => console.log(dom.clipboard.paste(event));
    paste(event)
    {
      if (!event)
        event = window;
      const clipboardData = event.clipboardData || window.clipboardData;
      return clipboardData ? clipboardData.getData("text") : "";
    }
  },

  events: {
    // necessary to retrieve the right key before Chrome 51
    key(event)
    {
      return "key" in event ? event.key : keys[event.keyCode];
    }
  },

  // helper to provide the relative coordinates
  // to the closest positioned containing element
  relativeCoordinates(event)
  {
    // good old way that will work properly in older browsers too
    // mandatory for Chrome 49, still better than manual fallback
    // in all other browsers that provide such functionality
    let el = event.currentTarget;
    if ("layerX" in event && "layerY" in event)
    {
      let {layerX} = event;
      // see https://issues.adblockplus.org/ticket/7134
      if (browserName === "firefox")
        layerX -= el.offsetLeft;
      return {x: layerX, y: event.layerY};
    }
    // fallback when layerX/Y will be removed (since deprecated)
    let x = 0;
    let y = 0;
    do
    {
      x += el.offsetLeft - el.scrollLeft;
      y += el.offsetTop - el.scrollTop;
    } while (
      (el = el.offsetParent) &&
      !isNaN(el.offsetLeft) &&
      !isNaN(el.offsetTop)
    );
    return {x: event.pageX - x, y: event.pageY - y};
  }
};

function asIndentedString(element, indentation = 0)
{
  // only the first time it's called
  if (!indentation)
  {
    // get the top meaningful element to parse
    if (element.nodeType === 9)
      element = element.documentElement;
    // accept only elements
    if (element.nodeType !== 1)
      throw new Error("Unable to serialize " + element);
    // avoid original XML pollution at first iteration
    element = element.cloneNode(true);
  }
  const before = "  ".repeat(indentation + 1);
  const after = "  ".repeat(indentation);
  const doc = element.ownerDocument;
  const children = element.children;
  const length = children.length;
  for (let i = 0; i < length; i++)
  {
    const child = children[i];
    element.insertBefore(doc.createTextNode(`\n${before}`), child);
    asIndentedString(child, indentation + 1);
    if ((i + 1) === length)
      element.appendChild(doc.createTextNode(`\n${after}`));
  }
  // inner calls don't need to bother serialization
  if (indentation)
    return "";
  // easiest way to recognize an HTML element from an XML one
  if (/^https?:\/\/www\.w3\.org\/1999\/xhtml$/.test(element.namespaceURI))
    return element.outerHTML;
  // all other elements should use XML serializer
  return new XMLSerializer().serializeToString(element);
}

},{}],4:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");

class IOCheckbox extends IOElement
{
  static get booleanAttributes()
  {
    return ["checked", "disabled"];
  }

  attributeChangedCallback()
  {
    this.render();
  }

  created()
  {
    this.addEventListener("click", this);
    this.render();
  }

  onclick(event)
  {
    if (!this.disabled)
    {
      this.checked = !this.checked;
      this.dispatchEvent(new CustomEvent("change", {
        bubbles: true,
        cancelable: true,
        detail: this.checked
      }));
    }
  }

  render()
  {
    this.html`
    <button
      role="checkbox"
      disabled="${this.disabled}"
      aria-checked="${this.checked}"
      aria-disabled="${this.disabled}"
    />`;
  }
}

IOCheckbox.define("io-checkbox");

module.exports = IOCheckbox;

},{"./io-element":5}],5:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

// Custom Elements ponyfill (a polyfill triggered on demand)
const customElementsPonyfill = require("document-register-element/pony");
if (typeof customElements !== "object")
  customElementsPonyfill(window);

// external dependencies
const {default: HyperHTMLElement} = require("hyperhtml-element/cjs");

// common DOM utilities exposed as IOElement.utils
const DOMUtils = {

  // boolean related operations/helpers
  boolean: {
    // utils.boolean.attribute(node, name, setAsTrue):void
    // set a generic node attribute name as "true"
    // if value is a boolean one or it removes the attribute
    attribute(node, name, setAsTrue)
    {
      // don't use `this.value(value)` with `this` as context
      // to make destructuring of helpers always work.
      // @example
      // const {attribute: setBoolAttr} = IOElement.utils.boolean;
      // setBoolAttr(node, 'test', true);
      if (DOMUtils.boolean.value(setAsTrue))
      {
        node.setAttribute(name, "true");
      }
      else
      {
        node.removeAttribute(name);
      }
    },

    // utils.boolean.value(any):boolean
    // it returns either true or false
    // via truthy or falsy values, but also via strings
    // representing "true", "false" as well as "0" or "1"
    value(value)
    {
      if (typeof value === "string" && value.length)
      {
        try
        {
          value = JSON.parse(value);
        }
        catch (error)
        {
          // Ignore invalid JSON to continue using value as string
        }
      }
      return !!value;
    }
  },

  event: {
    // returns true if it's a left click or a touch event.
    // The left mouse button value is 0 and this
    // is compatible with pointers/touch events
    // where `button` might not be there.
    isLeftClick(event)
    {
      const re = /^(?:click|mouse|touch|pointer)/;
      return re.test(event.type) && !event.button;
    }
  }
};

// provides a unique-id suffix per each component
let counter = 0;

// common Custom Element class to extend
class IOElement extends HyperHTMLElement
{
  // exposes DOM helpers as read only utils
  static get utils()
  {
    return DOMUtils;
  }

  // get a unique ID or, if null, set one and returns it
  static getID(element)
  {
    return element.getAttribute("id") || IOElement.setID(element);
  }

  // set a unique ID to a generic element and returns the ID
  static setID(element)
  {
    const id = `${element.nodeName.toLowerCase()}-${counter++}`;
    element.setAttribute("id", id);
    return id;
  }

  // lazily retrieve or define a custom element ID
  get id()
  {
    return IOElement.getID(this);
  }

  // returns true only when the component is live and styled
  get ready()
  {
    return !!this.offsetParent && this.isStyled();
  }

  // whenever an element is created, render its content once
  created() { this.render(); }

  // based on a `--component-name: ready;` convention
  // under the `component-name {}` related stylesheet,
  // this method returns true only if such stylesheet
  // has been already loaded.
  isStyled()
  {
    const computed = window.getComputedStyle(this, null);
    const property = "--" + this.nodeName.toLowerCase();
    // in some case Edge returns '#fff' instead of ready
    return computed.getPropertyValue(property).trim() !== "";
  }

  // by default, render is a no-op
  render() {}

  // usually a template would contain a main element such
  // input, button, div, section, etc.
  // having a simple way to retrieve such element can be
  // both semantic and handy, as opposite of using
  // this.children[0] each time
  get child()
  {
    let element = this.firstElementChild;
    // if accessed too early, will render automatically
    if (!element)
    {
      this.render();
      element = this.firstElementChild;
    }
    return element;
  }
}

// whenever an interpolation with ${{i18n: 'string-id'}} is found
// transform such value into the expected content
// example:
//  render() {
//    return this.html`<div>${{i18n:'about-abp'}}</div>`;
//  }
const {setElementText} = ext.i18n;
IOElement.intent("i18n", id =>
{
  const fragment = document.createDocumentFragment();
  setElementText(fragment, id);
  return fragment;
});

module.exports = IOElement;

},{"document-register-element/pony":24,"hyperhtml-element/cjs":31}],6:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

require("./io-checkbox");
require("./io-toggle");

const IOElement = require("./io-element");
const IOScrollbar = require("./io-scrollbar");

const {utils, wire} = IOElement;

const {port} = require("./api");
const {$, events} = require("./dom");

const prevFilterText = new WeakMap();

port.postMessage({
  type: "filters.listen",
  filter: ["disabled"]
});

// <io-filter-list disabled />.{filters = [...]}
class IOFilterList extends IOElement
{
  static get booleanAttributes()
  {
    return ["disabled"];
  }

  static get observedAttributes()
  {
    return ["filters"];
  }

  get selected()
  {
    return this._selected || (this._selected = new Set());
  }

  set selected(value)
  {
    this._selected = new Set(value);
    this.render();
  }

  get defaultState()
  {
    return {
      infinite: false,
      filters: [],
      viewHeight: 0,
      rowHeight: 0,
      scrollTop: 0,
      scrollHeight: 0,
      tbody: null,
      sort: {
        current: "",
        asc: false
      },
      sortMap: {
        status: "disabled",
        rule: "text",
        warning: "slow"
      }
    };
  }

  get filters()
  {
    return this.state.filters || [];
  }

  set filters(value)
  {
    // if the offsetParent is null, hence the component is not visible, or
    // if the related CSS is not loaded yet, this component cannot bootstrap
    // because its TBODY will never be scrollable so there's no way
    // to calculate its viewport height in pixels
    // in such case, just execute later on until the CSS is parsed
    if (!this.ready)
    {
      this._filters = value;
      return;
    }
    this.selected = [];
    // clear any previous --rule-width info
    this.style.setProperty("--rule-width", "auto");
    // render one row only for the setup
    this.setState({infinite: false, filters: []});
    // set current flex grown rule column
    this.style.setProperty(
      "--rule-width",
      $('[data-column="rule"]', this).clientWidth + "px"
    );
    // if filters have more than a row
    // prepare the table with a new state
    if (value.length)
    {
      const tbody = $("tbody", this);
      const rowHeight = $("tr", tbody).clientHeight;
      const viewHeight = tbody.clientHeight;
      this.setState({
        infinite: true,
        filters: value,
        scrollTop: tbody.scrollTop,
        scrollHeight: rowHeight * (value.length + 1) - viewHeight,
        viewHeight,
        rowHeight
      });
      // needed mostly for Firefox and Edge to have extra rows
      // reflecting the same weight of others
      this.style.setProperty("--row-height", `${rowHeight}px`);
      // setup the scrollbar size too
      this.scrollbar.size = rowHeight * value.length;
    }
  }

  created()
  {
    setupPort.call(this);

    // force one off setup whenever the component enters the view
    if (!this.ready)
      this.addEventListener(
        "animationstart",
        function prepare(event)
        {
          this.removeEventListener(event.type, prepare);
          if (this._filters)
          {
            this.filters = this._filters;
            this._filters = null;
          }
        }
      );

    // the rest of the setup
    this.scrollbar = new IOScrollbar();
    this.scrollbar.direction = "vertical";
    this.scrollbar.addEventListener("scroll", () =>
    {
      const {position, range} = this.scrollbar;
      const {scrollHeight} = this.state;
      this.setState({
        scrollTop: getScrollTop(scrollHeight * position / range)
      });
    });
    this.addEventListener(
      "wheel",
      event =>
      {
        event.preventDefault();
        // prevent race conditions between the blur event and the scroll
        const activeElement = this.ownerDocument.activeElement;
        if (activeElement && activeElement !== this.ownerDocument.body)
        {
          activeElement.blur();
          return;
        }
        const {scrollHeight, scrollTop} = this.state;
        this.setState({
          scrollTop: getScrollTop(scrollTop + event.deltaY, scrollHeight)
        });
        // update the scrollbar position accordingly
        updateScrollbarPosition.call(this);
      },
      {passive: false}
    );
    setScrollbarReactiveOpacity.call(this);
  }

  scrollTo(row)
  {
    const {rowHeight, scrollHeight} = this.state;
    const index = typeof row === "string" ?
      this.filters.findIndex(filter => filter.text === row) :
      this.filters.findIndex(filter => filter === row);
    if (index < 0)
      console.error("invalid filter", row);
    else
    {
      this.setState({
        scrollTop: getScrollTop(index * rowHeight, scrollHeight)
      });
      updateScrollbarPosition.call(this);
    }
  }

  onheaderclick(event)
  {
    const th = event.target.closest("th");
    if (!utils.event.isLeftClick(event) || !th)
      return;
    const {column} = th.dataset;
    if (column === "selected")
    {
      const ioCheckbox = event.target.closest("io-checkbox");
      // ignore clicks outside the io-checkbox
      if (ioCheckbox)
        this.selected = ioCheckbox.checked ? this.filters : [];
      return;
    }
    event.preventDefault();
    const {sort, sortMap} = this.state;
    if (column !== sort.current)
    {
      sort.current = column;
      sort.asc = false;
    }
    sort.asc = !sort.asc;
    const sorter = sort.asc ? 1 : -1;
    const property = sortMap[column];
    const direction = property === "slow" ? -1 : 1;
    this.filters.sort((fa, fb) =>
    {
      if (fa[property] === fb[property])
        return 0;
      return (fa[property] < fb[property] ? -sorter : sorter) * direction;
    });
    this.render();
    const dataset = th.closest("thead").dataset;
    dataset.sort = column;
    dataset.dir = sort.asc ? "asc" : "desc";
  }

  onpaste(event)
  {
    event.preventDefault();

    const data = event.clipboardData.getData("text/plain");
    // Filters must be written within a single line so we're ignoring any
    // subsequent lines in case clipboard data contains multiple lines.
    const [text] = data.trim().split("\n", 1);
    document.execCommand("insertText", false, text);
  }

  onkeydown(event)
  {
    const key = events.key(event);
    if (key === "Enter" || key === "Escape")
    {
      event.preventDefault();
      if (key === "Escape" && this._filter)
      {
        const {currentTarget} = event;
        const text = prevFilterText.get(this._filter) || this._filter.text;
        currentTarget.textContent = text;
        currentTarget.blur();
        this._filter = null;
      }
    }
  }

  onkeyup(event)
  {
    const isEnter = events.key(event) === "Enter";
    const update = isEnter || event.type === "blur";
    const {currentTarget} = event;
    const {title} = currentTarget;
    const text = currentTarget.textContent.trim();
    const filter = this._filter;

    // if triggered but there was focus lost already: return
    if (!filter)
      return;

    // in case of empty filter, remove it
    if (!text)
    {
      if (!update)
        return;
      browser.runtime.sendMessage({
        type: "filters.remove",
        text: filter.text
      }).then(errors =>
      {
        if (!errors.length)
        {
          this.selected.delete(filter);
          this.render();
          this.dispatchEvent(new CustomEvent("filter:removed", {
            cancelable: false,
            bubbles: true
          }));
        }
      });
      this._filter = null;
      return;
    }

    // store the initial filter value once
    // needed to remove the filter once finished the editing
    if (!prevFilterText.has(filter))
      prevFilterText.set(filter, title);

    // avoid updating filters that didn't change
    if (prevFilterText.get(filter) === text)
    {
      if (isEnter)
        focusTheNextFilterIfAny.call(this, currentTarget.closest("tr"));
      return;
    }

    // add + remove the filter on Enter / update
    if (update)
    {
      filter.text = text;
      currentTarget.title = text;
      // drop any validation action at distance
      this._validating = 0;
      if (this.filters.some(f => f.text === filter.text && f !== filter))
      {
        const {reason} = filter;
        filter.reason = browser.i18n.getMessage("filter_duplicated");

        // render only if there's something different to show
        if (filter.reason !== reason)
        {
          this.render();
        }
      }
      else
      {
        replaceFilter.call(this, filter, currentTarget);
        if (isEnter)
          focusTheNextFilterIfAny.call(this, currentTarget.closest("tr"));
      }
      return;
    }

    // don't overload validation
    if (this._validating > 0)
    {
      // but signal there is more validation to do
      this._validating++;
      return;
    }
    this._validating = 1;
    browser.runtime.sendMessage({
      type: "filters.validate",
      text
    }).then(errors =>
    {
      // in case a save operation has been asked in the meanwhile
      if (this._validating < 1)
        return;
      // if there were more validation requests
      if (this._validating > 1)
      {
        // reset the counter
        this._validating = 0;
        // re-trigger the event with same target
        this.onkeyup({currentTarget});
        return;
      }
      const {reason} = filter;
      if (errors.length)
        filter.reason = errors[0];
      else
        delete filter.reason;
      // render only if there's something different to show
      if (reason !== filter.reason)
        this.render();
    });
  }

  onfocus(event)
  {
    this._filter = event.currentTarget.data;
  }

  onblur(event)
  {
    // needed to avoid ellipsis on overflow hidden
    // make the filter look like disappeared from the list
    event.currentTarget.scrollLeft = 0;
    if (this._changingFocus)
    {
      this._filter = null;
      return;
    }
    this.onkeyup(event);
    this._filter = null;
  }

  // used in the checkbox of the selected column only
  onclick(event)
  {
    const filter = getFilter(event);
    const {filters} = this;
    if (event.shiftKey && this.selected.size)
    {
      let start = filters.indexOf(this._lastFilter);
      const end = filters.indexOf(filter);
      const method = this.selected.has(this._lastFilter) ?
                          "add" :
                          "delete";
      if (start < end)
      {
        while (start++ < end)
          this.selected[method](filters[start]);
      }
      else
      {
        while (start-- > end)
          this.selected[method](filters[start]);
      }
    }
    else
    {
      this._lastFilter = filter;
      if (this.selected.has(filter))
        this.selected.delete(filter);
      else
        this.selected.add(filter);
    }
    // render updated right after the checkbox changes
  }

  // used in both selected and status
  // the selected needs it to render at the right time
  // which is when the checkbox status changed
  // not when it's clicked
  onchange(event)
  {
    const {currentTarget} = event;
    const td = currentTarget.closest("td");
    if (td.dataset.column === "status")
    {
      const checkbox = currentTarget.closest("io-toggle");
      const filter = getFilter(event);
      filter.disabled = !checkbox.checked;
      browser.runtime.sendMessage({
        type: "filters.toggle",
        text: filter.text,
        disabled: filter.disabled
      });
    }
    else
    {
      this.render();
    }
  }

  postRender(list)
  {
    const {tbody, scrollTop, rowHeight} = this.state;
    if (this.state.infinite)
    {
      tbody.scrollTop = scrollTop % rowHeight;
    }
    // keep growing the fake list until the tbody becomes scrollable
    else if (
      !tbody ||
      (tbody.scrollHeight <= tbody.clientHeight && tbody.clientHeight)
    )
    {
      this.setState({
        tbody: tbody || $("tbody", this),
        filters: list.concat({})
      });
    }
  }

  render()
  {
    let list = this.state.filters;
    if (this.state.infinite)
    {
      list = [];
      const {rowHeight, scrollTop, viewHeight} = this.state;
      const length = this.state.filters.length;
      let count = 0;
      let i = Math.floor(scrollTop / rowHeight);
      // always add an extra row to make scrolling smooth
      while ((count * rowHeight) < (viewHeight + rowHeight))
      {
        list[count++] = i < length ? this.state.filters[i++] : null;
      }
    }
    const {length} = this.filters;
    this.html`<table cellpadding="0" cellspacing="0">
      <thead onclick="${this}" data-call="onheaderclick">
        <th data-column="selected">
          <io-checkbox checked=${!!length && this.selected.size === length} />
        </th>
        <th data-column="status"></th>
        <th data-column="rule">${{i18n: "options_filter_list_rule"}}</th>
        <th data-column="warning">${
          // for the header, just return always the same warning icon
          warnings.get(this) ||
          warnings.set(this, createImageForType(false)).get(this)
        }</th>
      </thead>
      <tbody>${list.map(getRow, this)}</tbody>
      ${this.scrollbar}
    </table>`;
    this.postRender(list);
  }

  sortBy(type, isAscending)
  {
    const th = $(`th[data-column="${type}"]`, this);
    if (!th)
    {
      console.error(`unable to sort by ${type}`);
      return;
    }
    const {sort} = this.state;
    sort.current = type;
    // sort.asc is flipped with current state
    // so set the one that is not desired
    sort.asc = !isAscending;
    // before triggering the event
    th.click();
  }

  updateScrollbar()
  {
    const {rowHeight, viewHeight} = this.state;
    const {length} = this.filters;
    this.scrollbar.size = rowHeight * length;
    this.setState({
      scrollHeight: rowHeight * (length + 1) - viewHeight
    });
  }
}

IOFilterList.define("io-filter-list");

module.exports = IOFilterList;

// delegates the handling of errors
function dispatchError(reason, filter)
{
  this.dispatchEvent(new CustomEvent("error", {
    cancelable: false,
    bubbles: true,
    detail: {
      reason,
      filter
    }
  }));
}

// Please note: the contenteditable=${...} attribute
// cannot be set directly to the TD because of an ugly
// MS Edge bug that does not allow TDs to be editable.
function getRow(filter, i)
{
  if (filter)
  {
    const selected = this.selected.has(filter);
    return wire(filter)`
    <tr class="${selected ? "selected" : ""}">
      <td data-column="selected">
        <io-checkbox
          checked="${selected}"
          onclick="${this}" onchange="${this}"
        />
      </td>
      <td data-column="status">
        <!-- Not all filters can be en-/disabled (e.g. comments) -->
        <io-toggle
          checked="${!filter.disabled}"
          disabled="${!("disabled" in filter)}"
          aria-hidden="${!("disabled" in filter)}"
          onchange="${this}"
        />
      </td>
      <td data-column="rule">
        <div
          class="content"
          contenteditable="${!this.disabled}"
          title="${filter.text}"
          onpaste="${this}"
          onkeydown="${this}"
          onkeyup="${this}"
          onfocus="${this}"
          onblur="${this}"
          data="${filter}"
        >${filter.text}</div>
      </td>
      <td data-column="warning">
        ${getWarning(filter)}
      </td>
    </tr>`;
  }
  // no filter results into an empty, not editable, row
  return wire(this, `:${i}`)`
    <tr class="empty">
      <td data-column="selected"></td>
      <td data-column="status"></td>
      <td data-column="rule"></td>
      <td data-column="warning"></td>
    </tr>`;
}

// used to show issues in the last column
const issues = new WeakMap();

// used to show warnings in the last column
const warnings = new WeakMap();
const warningSlow = browser.i18n.getMessage("filter_slow");

// relate either issues or warnings to a filter
const createImageForFilter = (weakMap, filter) =>
{
  const isIssue = weakMap === issues;
  const image = createImageForType(isIssue);
  if (isIssue)
  {
    image.title = filter.reason ||
      browser.i18n.getMessage("filter_action_failed");
  }
  else
    image.title = warningSlow;
  weakMap.set(filter, image);
  return image;
};

const createImageForType = (isIssue) =>
{
  const image = new Image();
  image.src = `skin/icons/${isIssue ? "error" : "alert"}.svg`;
  return image;
};

function focusTheNextFilterIfAny(tr)
{
  const i = this.filters.indexOf(this._filter) + 1;
  if (i < this.filters.length)
  {
    const next = tr.nextElementSibling;
    const {rowHeight, scrollTop, viewHeight} = this.state;
    // used to avoid race conditions with blur event
    this._changingFocus = true;
    // force eventually the scrollTop to make
    // the next row visible
    if (next.offsetTop > viewHeight)
    {
      this.setState({
        scrollTop: getScrollTop(scrollTop + rowHeight)
      });
    }
    // focus its content field
    $(".content", next).focus();
    // set back the _changingFocus
    this._changingFocus = false;
  }
}

function animateAndDrop(target)
{
  target.addEventListener("animationend", dropSavedClass);
  target.classList.add("saved");
}

function dropSavedClass(event)
{
  const {currentTarget} = event;
  currentTarget.classList.remove("saved");
  currentTarget.removeEventListener(event.type, dropSavedClass);
}

function getFilter(event)
{
  const el = event.currentTarget;
  const div = $('td[data-column="rule"] > .content', el.closest("tr"));
  return div.data;
}

// ensure the number is always between 0 and a positive number
// specially handy when filters are erased and the viewHeight
// is higher than scrollHeight and other cases too
function getScrollTop(value, scrollHeight)
{
  const scrollTop = Math.max(
    0,
    Math.min(scrollHeight || Infinity, value)
  );
  // avoid division by zero gotchas
  return isNaN(scrollTop) ? 0 : scrollTop;
}

function getWarning(filter)
{
  if (typeof filter.reason === "string")
    return issues.get(filter) || createImageForFilter(issues, filter);
  if (filter.slow)
    return warnings.get(filter) || createImageForFilter(warnings, filter);
  return "";
}

function replaceFilter(filter, currentTarget)
{
  const {text} = filter;
  const old = prevFilterText.get(filter);
  // if same text, no need to bother the extension at all
  if (old === text)
  {
    animateAndDrop(currentTarget);
    return;
  }
  browser.runtime.sendMessage({
    type: "filters.replace",
    new: text,
    old
  }).then(errors =>
  {
    if (errors.length)
    {
      filter.reason = errors[0];
    }
    else
    {
      // see https://gitlab.com/eyeo/adblockplus/abpui/adblockplusui/issues/338
      // until that lands, we remove the filter and add it at the end
      // of the table so, before rendering, drop the new filter and update
      // the current known one
      const {filters} = this;
      let i = filters.length;
      let newFilter;
      while (i--)
      {
        newFilter = filters[i];
        if (newFilter.text === text)
          break;
      }
      filters.splice(i, 1);
      delete filter.disabled;
      delete filter.reason;
      Object.assign(filter, newFilter);
      prevFilterText.set(filter, text);
      animateAndDrop(currentTarget);
    }
    this.render();
  });
}

function setScrollbarReactiveOpacity()
{
  // get native value for undefined opacity
  const opacity = this.scrollbar.style.opacity;
  // cache it once to never duplicate listeners
  const cancelOpacity = () =>
  {
    // store default opacity value back
    this.scrollbar.style.opacity = opacity;
    // drop all listeners
    document.removeEventListener("pointerup", cancelOpacity);
    document.removeEventListener("pointercancel", cancelOpacity);
  };
  // add listeners on scrollbaro pointerdown event
  this.scrollbar.addEventListener("pointerdown", () =>
  {
    this.scrollbar.style.opacity = 1;
    document.addEventListener("pointerup", cancelOpacity);
    document.addEventListener("pointercancel", cancelOpacity);
  });
}

// listen to filters messages and eventually
// delegate the error handling
function setupPort()
{
  port.onMessage.addListener((message) =>
  {
    if (message.type === "filters.respond" && message.action === "disabled")
    {
      const {text, disabled} = message.args[0];
      const filter = this.filters.find(f => f.text === text);
      if (filter && disabled !== filter.disabled)
      {
        filter.reason = browser.i18n.getMessage("filter_disabled");
        filter.disabled = disabled;
      }
      this.render();
    }
  });
}

function updateScrollbarPosition()
{
  const {scrollbar, state} = this;
  const {scrollHeight, scrollTop} = state;
  scrollbar.position = scrollTop * scrollbar.range / scrollHeight;
}

},{"./api":1,"./dom":3,"./io-checkbox":4,"./io-element":5,"./io-scrollbar":11,"./io-toggle":12}],7:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");

const {$, events} = require("./dom");

const MINIMUM_SEARCH_LENGTH = 3;

// this component simply emits filter:add(text)
// and filter:match({accuracy, filter}) events
class IOFilterSearch extends IOElement
{
  static get booleanAttributes()
  {
    return ["disabled"];
  }

  static get observedAttributes()
  {
    return ["match"];
  }

  get defaultState()
  {
    return {
      filterExists: true,
      filters: [],
      match: -1
    };
  }

  get filters()
  {
    return this.state.filters;
  }

  // filters are never modified or copied
  // but used to find out if one could be added
  // or if the component in charge should show the found one
  set filters(value)
  {
    this.setState({filters: value || []});
  }

  get match()
  {
    return this.state.match;
  }

  // match is a number between -1 and 1
  // -1 means any match
  // 1 means exact match
  // 0 means match disabled => no filter:match event ever
  set match(value)
  {
    this.setState({
      match: Math.max(-1, Math.min(1, parseFloat(value) || 0))
    }, false);
  }

  get value()
  {
    return $("input", this).value.trim();
  }

  set value(text)
  {
    const value = String(text || "").trim();
    $("input", this).value = value;
    this.setState({
      filterExists: value.length ?
                      this.state.filters.some(hasValue, value) :
                      false
    });
  }

  attributeChangedCallback(name, previous, current)
  {
    if (name === "match")
      this.match = current;
    else
      this.render();
  }

  created()
  {
    const {i18n} = browser;
    this._placeholder = i18n.getMessage("options_filters_search_or_add");
    this._addingFilter = false;
    this._timer = 0;
    this.render();
  }

  onclick()
  {
    if (this.value)
      addFilter.call(this, this.value);
  }

  ondrop(event)
  {
    event.preventDefault();
    addFilter.call(this, event.dataTransfer.getData("text"));
  }

  onkeydown(event)
  {
    switch (events.key(event))
    {
      case "Enter":
        const {value} = this;
        if (
          value.length &&
          !this.disabled &&
          !this.state.filters.some(hasValue, value)
        )
          addFilter.call(this, value);
        break;
      case "Escape":
        dispatch.call(this, "filter:none");
        this.value = "";
        break;
    }
  }

  onkeyup()
  {
    // clear timeout on any action
    clearTimeout(this._timer);

    // in case it was just added, don't do anything
    if (this._addingFilter)
    {
      this._addingFilter = false;
      return;
    }

    // debounce the search operations to avoid degrading
    // performance on very long list of filters
    this._timer = setTimeout(() =>
    {
      this._timer = 0;

      const {match, value} = this;
      // clear on backspace
      if (!value.length)
      {
        dispatch.call(this, "filter:none");
        this.value = "";
      }
      // do nothing when the search text is too small
      // also no match means don't validate
      // but also multi line (paste on old browsers)
      // shouldn't pass through this logic (filtered later on)
      else if (
        !match ||
        value.length < MINIMUM_SEARCH_LENGTH ||
        isMultiLine(value)
      )
      {
        this.setState({filterExists: this.state.filters.some(hasValue, value)});
        dispatch.call(this, "filter:none");
      }
      else
      {
        const result = search.call(this, value);
        if (result.accuracy && match <= result.accuracy)
          dispatch.call(this, "filter:match", result);
        else
          dispatch.call(this, "filter:none");
      }
    }, 100);
  }

  onpaste(event)
  {
    const clipboardData = event.clipboardData || window.clipboardData;
    const data = clipboardData.getData("text").trim();
    // do not automatically paste on single line
    if (isMultiLine(data))
      addFilter.call(this, data);
  }

  render()
  {
    const {disabled} = this;
    this.html`
    <input
      placeholder="${this._placeholder}"
      onkeydown="${this}" onkeyup="${this}"
      ondrop="${this}" onpaste="${this}"
      disabled="${disabled}"
    >
    <button
      onclick="${this}"
      disabled="${disabled || this.state.filterExists || !this.value}">
      + ${{i18n: "add"}}
    </button>`;
  }
}

IOFilterSearch.define("io-filter-search");

module.exports = IOFilterSearch;

function addFilter(data)
{
  dispatch.call(this, "filter:none");
  let value = data.trim();
  if (!value)
    return;

  // in case of multi line don't bother the search
  if (isMultiLine(value))
  {
    value = clearMultiLine(value);
    dispatch.call(this, "filter:add", value);
  }
  else
  {
    const result = search.call(this, value);
    if (result.accuracy < 1)
    {
      this._addingFilter = true;
      dispatch.call(this, "filter:add", value);
    }
    else if (result.accuracy && value.length >= MINIMUM_SEARCH_LENGTH)
      dispatch.call(this, "filter:match", result);
  }
}

function dispatch(type, detail)
{
  if (type === "filter:add" || this.filters.length)
    this.dispatchEvent(new CustomEvent(type, {detail}));
}

function hasValue(filter)
{
  return filter.text == this;
}

function clearMultiLine(data)
{
  return data.split(/[\r\n]/)
              .map(text => text.trim())
              .filter(text => text.length)
              .join("\n");
}

function isMultiLine(data)
{
  return /[\r\n]/.test(data.trim());
}

function search(value)
{
  let accuracy = 0;
  let closerFilter = null;
  const matches = [];
  const searchLength = value.length;
  if (searchLength)
  {
    const match = this.match;
    const {filters} = this.state;
    const {length} = filters;
    for (let i = 0; i < length; i++)
    {
      const filter = filters[i];
      const filterLength = filter.text.length;
      // ignore all filters shorter than current search
      if (searchLength > filterLength)
        continue;
      // compare the two strings only if length is the same
      if (searchLength === filterLength)
      {
        if (filter.text === value)
        {
          matches.push(filter);
          closerFilter = filter;
          accuracy = 1;
        }
        continue;
      }
      // otherwise verify text includes searched value
      // only if the match is not meant to be 1:1
      if (match < 1 && filter.text.includes(value))
      {
        matches.push(filter);
        const tmpAccuracy = searchLength / filterLength;
        if (accuracy < tmpAccuracy)
        {
          closerFilter = filter;
          accuracy = tmpAccuracy;
        }
      }
    }
    this.setState({filterExists: accuracy === 1});
  }
  return {accuracy, matches, value, filter: closerFilter};
}

},{"./dom":3,"./io-element":5}],8:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");
const IOFilterList = require("./io-filter-list");
const IOFilterSearch = require("./io-filter-search");

const {clipboard} = require("./dom");

const {bind, wire} = IOElement;

// io-filter-table is a basic controller
// used to relate the search and the list
class IOFilterTable extends IOElement
{
  static get booleanAttributes()
  {
    return ["disabled"];
  }

  static get observedAttributes()
  {
    return ["match"];
  }

  get defaultState()
  {
    return {filters: [], match: -1, ready: false};
  }

  created()
  {
    this._showing = null;
    this.search = this.appendChild(new IOFilterSearch());
    this.search.addEventListener(
      "filter:add",
      event => this.onFilterAdd(event)
    );
    this.search.addEventListener(
      "filter:match",
      event => this.onFilterMatch(event)
    );
    this.search.addEventListener(
      "filter:none",
      () =>
      {
        this.list.selected = [];
        this.updateFooter();
      }
    );
    this.list = this.appendChild(new IOFilterList());
    this.list.addEventListener(
      "filter:removed",
      event => this.onFilterRemoved(event)
    );
    this.footer = this.appendChild(wire()`<div class="footer" />`);
    this.addEventListener("click", this);
    this.addEventListener("error", this);
    this.setState({ready: true});
  }

  attributeChangedCallback(name, prev, value)
  {
    if (name === "match")
      this.setState({match: value}, false);
    this.render();
  }

  get filters()
  {
    return this.state.filters;
  }

  set filters(value)
  {
    this.setState({filters: value});
  }

  get match()
  {
    return this.state.match;
  }

  set match(value)
  {
    this.setState({match: value});
  }

  onclick(event)
  {
    if (event.target.closest("io-checkbox"))
    {
      cleanErrors.call(this);
    }
  }

  onerror(event)
  {
    // force the footer to be visible since errors are shown there
    this.updateFooter();
    this.footer.classList.add("visible");
    const {errors} = event.detail;
    const footerError = this.querySelector(".footer .error");

    // Show a generic error message not only if we don't know what kind of
    // error occurred but also if we don't have an error message for it yet
    const errorMessages = errors.join("\n").trim();
    bind(footerError)`${
      errorMessages ?
        errorMessages :
        {i18n: "filter_action_failed"}
    }`;
  }

  onfooterclick(event)
  {
    const {classList} = event.currentTarget;
    switch (true)
    {
      case classList.contains("delete"):
        const resolve = [];
        for (const filter of this.list.selected)
        {
          this.list.selected.delete(filter);
          this.filters.splice(this.filters.indexOf(filter), 1);
          resolve.push(browser.runtime.sendMessage({
            type: "filters.remove",
            text: filter.text
          }));
        }
        Promise.all(resolve).then(
          () => updateList(this.list),
          (errors) => this.onerror({detail: {errors}})
        );
        cleanErrors.call(this);
        break;
      case classList.contains("copy"):
        const filters = [];
        for (const filter of this.list.selected)
        {
          filters.push(filter.text);
        }
        clipboard.copy(filters.join("\n"));
        break;
    }
  }

  onFilterAdd(event)
  {
    const filters = event.detail.split(/(?:\r\n|\n)/);

    cleanErrors.call(this);
    browser.runtime.sendMessage({
      type: "filters.importRaw",
      text: filters.join("\n")
    })
    .then(errors =>
    {
      if (!errors.length)
      {
        filters.reverse();
        let added = false;
        for (const text of filters)
        {
          // We don't treat filter headers like invalid filters,
          // instead we simply ignore them and don't show any errors
          // in order to allow pasting complete filter lists
          if (text[0] === "[")
            continue;

          added = true;
          const i = this.filters.findIndex(flt => flt.text === text);
          const [filter] = i < 0 ? [{text}] : this.filters.splice(i, 1);
          this.filters.unshift(filter);
        }

        this.search.value = "";
        if (!added)
          return;

        this.render();
        updateList(this.list);
        this.list.scrollTo(this.filters[0]);
        this.updateFooter();
      }
      else
      {
        this.onerror({detail: {errors}});
      }
    });
  }

  onFilterMatch(event)
  {
    const {accuracy, filter, matches} = event.detail;
    this.list.selected = matches;
    // scroll either to the exact match or the first close match
    this.list.scrollTo(accuracy === 1 ? filter : matches[0]);
    this.updateFooter();
  }

  onFilterRemoved()
  {
    cleanErrors.call(this);
    this.updateFooter();
  }

  render()
  {
    const {disabled} = this;
    const {filters, match, ready} = this.state;
    if (!ready || !filters.length)
      return;

    // update inner components setting filters
    // only if necessary
    this.search.disabled = disabled;
    this.search.match = match;
    if (this.search.filters !== filters)
      this.search.filters = filters;

    this.list.disabled = disabled;
    if (this.list.filters !== filters)
      this.list.filters = filters;

    this.updateFooter();
  }

  updateFooter()
  {
    const disabled = !this.list.selected.size;
    bind(this.footer)`
      <button
        class="delete"
        onclick="${this}"
        disabled="${disabled}"
        data-call="onfooterclick"
      >${{i18n: "delete"}}</button>
      <button
        class="copy"
        onclick="${this}"
        disabled="${disabled}"
        data-call="onfooterclick"
      >${{i18n: "copy_selected"}}</button>
      <button class="error"></button>
    `;
  }
}

IOFilterTable.define("io-filter-table");

function cleanErrors()
{
  const footerError = this.querySelector(".footer .error");
  if (footerError)
    bind(footerError)``;
  this.updateFooter();
}

function updateList(list)
{
  list.render();
  list.updateScrollbar();
}

},{"./dom":3,"./io-element":5,"./io-filter-list":6,"./io-filter-search":7}],9:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const DELAY = 200;

const IOElement = require("./io-element");

const {events} = require("./dom");

// used to create options
const {wire} = IOElement;

// used to map codes cross browser
const KeyCode = {
  ARROW_DOWN: "ArrowDown",
  ARROW_UP: "ArrowUp",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  ENTER: "Enter",
  ESCAPE: "Escape",
  END: "End",
  HOME: "Home",
  PAGE_DOWN: "PageDown",
  PAGE_UP: "PageUp",
  SPACE: " ",
  TAB: "Tab"
};

class IOListBox extends IOElement
{
  static get observedAttributes()
  {
    return ["action", "change", "disabled", "expanded", "items", "placeholder"];
  }

  created()
  {
    this._blurTimer = 0;
    this._bootstrap = true;
    this._text = browser.i18n.getMessage("options_language_add");
    // in case the component has been addressed and
    // it has already an attached items property
    if (this.hasOwnProperty("items"))
    {
      const items = this.items;
      delete this.items;
      this.items = items;
    }
  }

  // can be overridden but by default
  // it returns the item.originalTitle
  getItemTitle(item)
  {
    return item.originalTitle;
  }

  get change()
  {
    return !!this._change;
  }

  set change(value)
  {
    this._change = !!value;
  }

  // shortcuts to retrieve sub elements
  get label()
  {
    return this.querySelector(`#${this.id}label`);
  }

  get popup()
  {
    return this.querySelector(`#${this.id}popup`);
  }

  // component status
  get disabled()
  {
    return this.hasAttribute("disabled");
  }

  set disabled(value)
  {
    IOElement.utils.boolean.attribute(this, "disabled", value);
    this.render();
  }

  get expanded()
  {
    return this.hasAttribute("expanded");
  }

  set expanded(value)
  {
    IOElement.utils.boolean.attribute(this, "expanded", value);
    this.render();
    setTimeout(
      () =>
      {
        // be sure the eleemnt is blurred to re-open on focus
        if (!value)
          this.ownerDocument.activeElement.blur();
        this.dispatchEvent(new CustomEvent(value ? "open" : "close"));
      },
      DELAY + 1
    );
  }

  // items handler
  get items()
  {
    return this._items;
  }

  set items(items)
  {
    this._items = items;
    this.render();
    // WAI-ARIA guidelines:
    //  If an option is selected before the listbox receives focus,
    //  focus is set on the selected option.
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // if no items were passed, clean up
    // and bootstrap the next time.
    // The bootstrap will focus the right item.
    if (!items.length)
    {
      this._bootstrap = true;
    }
    // if it needs to bootstrap (cleanup or new component)
    else if (this._bootstrap)
    {
      this._bootstrap = false;
      for (const item of items)
      {
        // if an item is selected
        if (!item.disabled)
        {
          // simulate hover it and exit
          hover.call(this, "items", item);
          fixSize.call(this);
          return;
        }
      }
      // if no item was selected, hover the first one
      hover.call(this, "items", items[0]);
    }

    // ensure the list of items reflect the meant style
    fixSize.call(this);
  }

  // events related methods
  handleEvent(event)
  {
    if (!this.disabled)
    {
      this[`on${event.type}`](event);
    }
  }

  // label related events
  onblur(event)
  {
    // ensure blur won't close the list right away or it's impossible
    // to get the selected raw on click (bad target)
    if (this.expanded)
      this._blurTimer = setTimeout(() =>
      {
        this.expanded = false;
      }, DELAY);
  }

  onfocus(event)
  {
    // if 0 or already cleared, nothing happens, really
    clearTimeout(this._blurTimer);
    // show the popup
    this.expanded = true;
  }

  onkeydown(event)
  {
    const hovered = this.querySelector(".hover");
    switch (events.key(event))
    {
      case KeyCode.BACKSPACE:
      case KeyCode.DELETE:
        event.preventDefault();
        break;
      /* both SPACE, RETURN and ESC hide and blur */
      case KeyCode.ENTER:
      case KeyCode.SPACE:
        hovered.dispatchEvent(new CustomEvent("click", {bubbles: true}));
        /* eslint: fall through */
      case KeyCode.ESCAPE:
        event.preventDefault();
        this.expanded = false;
        break;
      case KeyCode.ARROW_UP:
        const prev = findNext.call(
          this,
          hovered, "previousElementSibling"
        );
        if (prev)
          hover.call(this, "key", getItem.call(this, prev.id));
        event.preventDefault();
        break;
      case KeyCode.ARROW_DOWN:
        const next = findNext.call(
          this,
          hovered, "nextElementSibling"
        );
        if (next)
          hover.call(this, "key", getItem.call(this, next.id));
        event.preventDefault();
        break;
    }
  }

  // popup related events
  onclick(event)
  {
    if (!IOElement.utils.event.isLeftClick(event))
      return;
    event.preventDefault();
    clearTimeout(this._blurTimer);
    const el = event.target.closest('[role="option"]');
    if (el)
    {
      if (el.getAttribute("aria-disabled") !== "true")
      {
        this.dispatchEvent(new CustomEvent("change", {
          detail: getItem.call(this, el.id)
        }));
      }
      this.expanded = false;
    }
  }

  onmousedown(event)
  {
    this.expanded = !this.expanded;
  }

  onmouseover(event)
  {
    const el = event.target.closest('[role="option"]');
    if (el && !el.classList.contains("hover"))
      hover.call(this, "mouse",
                  this._items.find(item => getID(item) === el.id));
  }

  // the view
  render()
  {
    const {change} = this;
    const enabled = this._items.filter(item => !item.disabled).length;
    this.html`
    <button
      role="combobox"
      aria-readonly="true"
      id="${this.id + "label"}"
      disabled="${this.disabled}"
      data-action="${this.action}"
      aria-owns="${this.id + "popup"}"
      aria-disabled="${this.disabled}"
      aria-expanded="${this.expanded}"
      aria-haspopup="${this.id + "popup"}"
      onblur="${this}" onfocus="${this}"
      onkeydown="${this}" onmousedown="${this}"
    >${this.expanded ? this.placeholder : this._text}</button>
    <ul
      role="listbox"
      tab-index="-1"
      id="${this.id + "popup"}"
      aria-labelledby="${this.id + "label"}"
      hidden="${!this.expanded}"
      onclick="${this}" onmouseover="${this}"
    >${this._items.map(item =>
    {
      const id = getID(item);
      const selected = !change && !item.disabled;
      const disabled = selected && enabled === 1;
      return wire(this, `html:${id}`)`
      <li
        id="${id}"
        role="option"
        aria-disabled="${change ? !item.disabled : disabled}"
        aria-selected="${selected}"
      >${this.getItemTitle(item)}</li>`;
    })}</ul>`;
  }
}

IOListBox.define("io-list-box");

// to retrieve a unique ID per item
function getID(item)
{
  // get a unique URL for each known item
  return `li-${item.url.split("").map(
    c => c.charCodeAt(0).toString(32)
  ).join("")}`;
}

// to retrieve an item from an option id
function getItem(id)
{
  return this._items.find(item => getID(item) === id);
}

// private helper
function hover(type, item)
{
  const id = getID(item);
  const hovered = this.querySelector(".hover");
  if (hovered)
    hovered.classList.remove("hover");
  const option = this.querySelector(`#${id}`);
  option.classList.add("hover");
  this.label.setAttribute("aria-activedescendant", id);
  const popup = this.popup;
  // if it's the mouse moving, don't auto scroll (annoying)
  if (type !== "mouse" && popup.scrollHeight > popup.clientHeight)
  {
    const scrollBottom = popup.clientHeight + popup.scrollTop;
    const elementBottom = option.offsetTop + option.offsetHeight;
    if (elementBottom > scrollBottom)
    {
      popup.scrollTop = elementBottom - popup.clientHeight;
    }
    else if (option.offsetTop < popup.scrollTop)
    {
      popup.scrollTop = option.offsetTop;
    }
  }
}

// find next available hoverable node
function findNext(el, other)
{
  const first = el;
  do
  {
    el = el[other];
  } while (el && el !== first && !getItem.call(this, el.id).disabled);
  return el === first ? null : el;
}

function fixSize()
{
  if (!this._fixedSize)
  {
    this._fixedSize = true;
    this.style.setProperty("--height", this.label.offsetHeight + "px");
  }
}

},{"./dom":3,"./io-element":5}],10:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");

class IOPopout extends IOElement
{
  static get observedAttributes()
  {
    return ["expanded", "i18n-body", "type"];
  }

  created()
  {
    this._children = Array.from(this.children);
    this.addEventListener("blur", this);
    this.addEventListener("click", this);
    this.setAttribute("tabindex", 0);
  }

  attributeChangedCallback()
  {
    this.render();
  }

  onblur(ev)
  {
    if (ev.relatedTarget && this.contains(ev.relatedTarget))
      return;

    this.expanded = "";
  }

  onclick(ev)
  {
    const {target} = ev;

    if (target.classList.contains("wrapper"))
    {
      ev.preventDefault();

      if (this.expanded)
      {
        this.expanded = "";
      }
      else if (this.type == "tooltip")
      {
        const {bottom, top} = ev.target.getBoundingClientRect();
        this.expanded = (screen.availHeight - bottom > top) ? "below" : "above";
      }
      else
      {
        this.expanded = "start";
      }
    }
    else if (target.nodeName == "A" || target.nodeName == "BUTTON")
    {
      this.expanded = "";
    }
  }

  render()
  {
    const {wire} = IOPopout;

    const role = this.type || "tooltip";
    const content = [];

    if (role == "tooltip")
    {
      content.push(wire(this, ":close")`
        <button class="icon close secondary"></button>
      `);
    }

    if (this.i18nBody)
    {
      content.push(wire(this, ":body")`
        <p>${{i18n: this.i18nBody}}</p>
      `);
    }

    content.push(...this._children);

    this.html`
    <div class="${["wrapper", "icon", role].join(" ")}">
      <div role="${role}" aria-hidden="${!this.expanded}">
        ${content}
      </div>
    </div>
    `;
  }
}

IOPopout.define("io-popout");

},{"./io-element":5}],11:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");
const {relativeCoordinates} = require("./dom");

const {isLeftClick} = IOElement.utils.event;

class IOScrollbar extends IOElement
{
  static get observedAttributes()
  {
    return ["direction", "position", "size"];
  }

  created()
  {
    this.addEventListener(
      "click",
      (event) =>
      {
        // ignore clicks on the slider or right clicks
        if (event.target !== this || !isLeftClick(event))
          return;
        // prevents clicks action on the component
        // after dragging the slider so that it won't
        // be re-positioned again on click coordinates
        if (this._dragging)
        {
          this._dragging = false;
          return;
        }
        const {x, y} = relativeCoordinates(event);
        if (this.direction === "horizontal")
          setPosition.call(this, x - (this._sliderSize / 2));
        else if (this.direction === "vertical")
          setPosition.call(this, y - (this._sliderSize / 2));
        this.dispatchEvent(new CustomEvent("scroll"));
      }
    );
    this.addEventListener(
      "wheel",
      (event) =>
      {
        stop(event);
        let delta = 0;
        if (this.direction === "vertical")
          delta = event.deltaY;
        else if (this.direction === "horizontal")
          delta = event.deltaX;
        // this extra delta transformation is mostly needed for MS Edge
        // but it works OK in every other browser too
        delta = delta * this._sliderSize / this.size;
        setPosition.call(this, this.position + delta);
        this.dispatchEvent(new CustomEvent("scroll"));
      },
      {passive: false}
    );
  }

  get defaultState()
  {
    return {
      direction: "",
      position: 0,
      size: 0
    };
  }

  get direction()
  {
    return this.state.direction;
  }

  // can be (ignore case) horizontal or vertical
  set direction(value)
  {
    value = value.toLowerCase();
    this.setState({direction: value});
    this.setAttribute("direction", value);
    // trigger eventual size recalculation
    sizeChange.call(this);
  }

  get position()
  {
    return this.state.position || 0;
  }

  set position(value)
  {
    if (!this._elSize)
      return;
    setPosition.call(this, value);
  }

  // read-only: the amount of positions covered by the slider
  get range()
  {
    return this._elSize - this._sliderSize;
  }

  get size()
  {
    return this.state.size;
  }

  set size(value)
  {
    this.setState({size: parseInt(value, 10)});
    sizeChange.call(this);
  }

  onmousedown(event)
  {
    if (!isLeftClick(event))
      return;
    this._dragging = true;
    this._coords = {
      x: event.clientX,
      y: event.clientY
    };
    const slider = event.currentTarget;
    const doc = slider.ownerDocument;
    // use the document as source of mouse events truth
    // use true as third option to intercept before bubbling
    doc.addEventListener("mousemove", this, true);
    doc.addEventListener("mouseup", this, true);
    // also prevents selection like a native scrollbar would
    // (this is specially needed for Firefox and Edge)
    doc.addEventListener("selectstart", stop, true);
  }

  onmousemove(event)
  {
    const {x, y} = this._coords;
    if (this.direction === "horizontal")
    {
      const {clientX} = event;
      setPosition.call(this, this.position + clientX - x);
      this._coords.x = clientX;
    }
    else if (this.direction === "vertical")
    {
      const {clientY} = event;
      setPosition.call(this, this.position + clientY - y);
      this._coords.y = clientY;
    }
    this.dispatchEvent(new CustomEvent("scroll"));
  }

  onmouseup(event)
  {
    if (!isLeftClick(event))
      return;
    const {currentTarget: doc, target} = event;
    doc.removeEventListener("mousemove", this, true);
    doc.removeEventListener("mouseup", this, true);
    doc.removeEventListener("selectstart", stop, true);
    // stop dragging if mouseup happens outside this component
    // or within this component slider (the only child)
    // otherwise let the click handler ignore the action
    // which happens through the component itself
    if (target !== this || target === this.child)
      this._dragging = false;
  }

  render()
  {
    // the component and its slider are styled 100% through CSS, i.e.
    // io-scrollbar[direction="vertical"] > .slider {}
    this.html`<div
      class="slider"
      onmousedown="${this}"
    />`;
  }
}

IOScrollbar.define("io-scrollbar");

module.exports = IOScrollbar;

function setPosition(value)
{
  this.setState({
    position: Math.max(
      0,
      Math.min(
        parseFloat(value),
        this.range
      )
    )
  });
  this.style.setProperty(
    "--position",
    this.state.position + "px"
  );
}

function sizeChange()
{
  if (this.direction === "horizontal")
    this._elSize = this.clientWidth;
  else if (this.direction === "vertical")
    this._elSize = this.clientHeight;
  this._sliderSize = Math.floor(
    Math.min(1, this._elSize / this.state.size) * this._elSize
  );
  if (this.direction === "horizontal")
    this._sliderSize = Math.max(this._sliderSize, this.clientHeight);
  else if (this.direction === "vertical")
    this._sliderSize = Math.max(this._sliderSize, this.clientWidth);
  this.style.setProperty("--slider-size", this._sliderSize + "px");
  // trigger eventual position recalculation
  // once this._elSize change
  // set again the style to re-position the scroller
  setPosition.call(this, this.position);
}

// if inside a container with its own wheel or mouse events,
// avoid possible backfiring through already handled events.
function stop(event)
{
  event.preventDefault();
  event.stopPropagation();
}

},{"./dom":3,"./io-element":5}],12:[function(require,module,exports){
/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const IOElement = require("./io-element");
const {boolean} = IOElement.utils;

class IOToggle extends IOElement
{
  // action, checked, and disabled should be reflected down the button
  static get observedAttributes()
  {
    return ["action", "checked", "disabled"];
  }

  created()
  {
    this.addEventListener("click", this);
    this.render();
  }

  get checked()
  {
    return this.hasAttribute("checked");
  }

  set checked(value)
  {
    boolean.attribute(this, "checked", value);
    this.render();
  }

  get disabled()
  {
    return this.hasAttribute("disabled");
  }

  set disabled(value)
  {
    boolean.attribute(this, "disabled", value);
  }

  onclick(event)
  {
    if (!this.disabled)
    {
      this.checked = !this.checked;
      if (this.ownerDocument.activeElement !== this.child)
      {
        this.child.focus();
      }
      this.dispatchEvent(new CustomEvent("change", {
        bubbles: true,
        cancelable: true,
        detail: this.checked
      }));
    }
  }

  render()
  {
    this.html`
    <button
      role="checkbox"
      disabled="${this.disabled}"
      data-action="${this.action}"
      aria-checked="${this.checked}"
      aria-disabled="${this.disabled}"
    />`;
  }
}

IOToggle.define("io-toggle");

module.exports = IOToggle;

},{"./io-element":5}],13:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var createContent = (function (document) {'use strict';
  var FRAGMENT = 'fragment';
  var TEMPLATE = 'template';
  var HAS_CONTENT = 'content' in create(TEMPLATE);

  var createHTML = HAS_CONTENT ?
    function (html) {
      var template = create(TEMPLATE);
      template.innerHTML = html;
      return template.content;
    } :
    function (html) {
      var content = create(FRAGMENT);
      var template = create(TEMPLATE);
      var childNodes = null;
      if (/^[^\S]*?<(col(?:group)?|t(?:head|body|foot|r|d|h))/i.test(html)) {
        var selector = RegExp.$1;
        template.innerHTML = '<table>' + html + '</table>';
        childNodes = template.querySelectorAll(selector);
      } else {
        template.innerHTML = html;
        childNodes = template.childNodes;
      }
      append(content, childNodes);
      return content;
    };

  return function createContent(markup, type) {
    return (type === 'svg' ? createSVG : createHTML)(markup);
  };

  function append(root, childNodes) {
    var length = childNodes.length;
    while (length--)
      root.appendChild(childNodes[0]);
  }

  function create(element) {
    return element === FRAGMENT ?
      document.createDocumentFragment() :
      document.createElementNS('http://www.w3.org/1999/xhtml', element);
  }

  // it could use createElementNS when hasNode is there
  // but this fallback is equally fast and easier to maintain
  // it is also battle tested already in all IE
  function createSVG(svg) {
    var content = create(FRAGMENT);
    var template = create('div');
    template.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + svg + '</svg>';
    append(content, template.firstChild.childNodes);
    return content;
  }

}(document));
module.exports = createContent;

},{}],14:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var self = this || /* istanbul ignore next */ {};
self.CustomEvent = typeof CustomEvent === 'function' ?
  CustomEvent :
  (function (__p__) {
    CustomEvent[__p__] = new CustomEvent('').constructor[__p__];
    return CustomEvent;
    function CustomEvent(type, init) {
      if (!init) init = {};
      var e = document.createEvent('CustomEvent');
      e.initCustomEvent(type, !!init.bubbles, !!init.cancelable, init.detail);
      return e;
    }
  }('prototype'));
module.exports = self.CustomEvent;

},{}],15:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var self = this || /* istanbul ignore next */ {};
try { self.Map = Map; }
catch (Map) {
  self.Map = function Map() {
    var i = 0;
    var k = [];
    var v = [];
    return {
      delete: function (key) {
        var had = contains(key);
        if (had) {
          k.splice(i, 1);
          v.splice(i, 1);
        }
        return had;
      },
      get: function get(key) {
        return contains(key) ? v[i] : void 0;
      },
      has: function has(key) {
        return contains(key);
      },
      set: function set(key, value) {
        v[contains(key) ? i : (k.push(key) - 1)] = value;
        return this;
      }
    };
    function contains(v) {
      i = k.indexOf(v);
      return -1 < i;
    }
  };
}
module.exports = self.Map;

},{}],16:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var self = this || /* istanbul ignore next */ {};
try { self.WeakSet = WeakSet; }
catch (WeakSet) {
  (function (id, dP) {
    var proto = WeakSet.prototype;
    proto.add = function (object) {
      if (!this.has(object))
        dP(object, this._, {value: true, configurable: true});
      return this;
    };
    proto.has = function (object) {
      return this.hasOwnProperty.call(object, this._);
    };
    proto.delete = function (object) {
      return this.has(object) && delete object[this._];
    };
    self.WeakSet = WeakSet;
    function WeakSet() {'use strict';
      dP(this, '_', {value: '_@ungap/weakmap' + id++});
    }
  }(Math.random(), Object.defineProperty));
}
module.exports = self.WeakSet;

},{}],17:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var importNode = (function (
  document,
  appendChild,
  cloneNode,
  createTextNode,
  importNode
) {
  var native = importNode in document;
  // IE 11 has problems with cloning templates:
  // it "forgets" empty childNodes. This feature-detects that.
  var fragment = document.createDocumentFragment();
  fragment[appendChild](document[createTextNode]('g'));
  fragment[appendChild](document[createTextNode](''));
  var content = native ?
    document[importNode](fragment, true) :
    fragment[cloneNode](true);
  return content.childNodes.length < 2 ?
    function importNode(node, deep) {
      var clone = node[cloneNode]();
      for (var
        childNodes = node.childNodes || [],
        length = childNodes.length,
        i = 0; deep && i < length; i++
      ) {
        clone[appendChild](importNode(childNodes[i], deep));
      }
      return clone;
    } :
    (native ?
      document[importNode] :
      function (node, deep) {
        return node[cloneNode](!!deep);
      }
    );
}(
  document,
  'appendChild',
  'cloneNode',
  'createTextNode',
  'importNode'
));
module.exports = importNode;

},{}],18:[function(require,module,exports){
var isArray = Array.isArray || (function (toString) {
  var $ = toString.call([]);
  return function isArray(object) {
    return toString.call(object) === $;
  };
}({}.toString));
module.exports = isArray;

},{}],19:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var templateLiteral = (function () {'use strict';
  var RAW = 'raw';
  var isNoOp = typeof document !== 'object';
  var templateLiteral = function (tl) {
    if (
      // for badly transpiled literals
      !(RAW in tl) ||
      // for some version of TypeScript
      tl.propertyIsEnumerable(RAW) ||
      // and some other version of TypeScript
      !Object.isFrozen(tl[RAW]) ||
      (
        // or for Firefox < 55
        /Firefox\/(\d+)/.test(
          (document.defaultView.navigator || {}).userAgent
        ) &&
        parseFloat(RegExp.$1) < 55
      )
    ) {
      var forever = {};
      templateLiteral = function (tl) {
        for (var key = '.', i = 0; i < tl.length; i++)
          key += tl[i].length + '.' + tl[i];
        return forever[key] || (forever[key] = tl);
      };
    } else {
      isNoOp = true;
    }
    return TL(tl);
  };
  return TL;
  function TL(tl) {
    return isNoOp ? tl : templateLiteral(tl);
  }
}());
module.exports = templateLiteral;

},{}],20:[function(require,module,exports){
'use strict';
const unique = (require('@ungap/template-literal'));

Object.defineProperty(exports, '__esModule', {value: true}).default = function (template) {
  var length = arguments.length;
  var args = [unique(template)];
  var i = 1;
  while (i < length)
    args.push(arguments[i++]);
  return args;
};

},{"@ungap/template-literal":19}],21:[function(require,module,exports){
var trim = ''.trim || function () {
  return String(this).replace(/^\s+|\s+/g, '');
};
module.exports = trim;

},{}],22:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var self = this || /* istanbul ignore next */ {};
try { self.WeakMap = WeakMap; }
catch (WeakMap) {
  // this could be better but 90% of the time
  // it's everything developers need as fallback
  self.WeakMap = (function (id, Object) {'use strict';
    var dP = Object.defineProperty;
    var hOP = Object.hasOwnProperty;
    var proto = WeakMap.prototype;
    proto.delete = function (key) {
      return this.has(key) && delete key[this._];
    };
    proto.get = function (key) {
      return this.has(key) ? key[this._] : void 0;
    };
    proto.has = function (key) {
      return hOP.call(key, this._);
    };
    proto.set = function (key, value) {
      dP(key, this._, {configurable: true, value: value});
      return this;
    };
    return WeakMap;
    function WeakMap(iterable) {
      dP(this, '_', {value: '_@ungap/weakmap' + id++});
      if (iterable)
        iterable.forEach(add, this);
    }
    function add(pair) {
      this.set(pair[0], pair[1]);
    }
  }(Math.random(), Object));
}
module.exports = self.WeakMap;

},{}],23:[function(require,module,exports){
/*! (c) Andrea Giammarchi */
function disconnected(poly) {'use strict';
  var CONNECTED = 'connected';
  var DISCONNECTED = 'dis' + CONNECTED;
  var Event = poly.Event;
  var WeakSet = poly.WeakSet;
  var notObserving = true;
  var observer = new WeakSet;
  return function observe(node) {
    if (notObserving) {
      notObserving = !notObserving;
      startObserving(node.ownerDocument);
    }
    observer.add(node);
    return node;
  };
  function startObserving(document) {
    var dispatched = null;
    try {
      (new MutationObserver(changes)).observe(
        document,
        {subtree: true, childList: true}
      );
    }
    catch(o_O) {
      var timer = 0;
      var records = [];
      var reschedule = function (record) {
        records.push(record);
        clearTimeout(timer);
        timer = setTimeout(
          function () {
            changes(records.splice(timer = 0, records.length));
          },
          0
        );
      };
      document.addEventListener(
        'DOMNodeRemoved',
        function (event) {
          reschedule({addedNodes: [], removedNodes: [event.target]});
        },
        true
      );
      document.addEventListener(
        'DOMNodeInserted',
        function (event) {
          reschedule({addedNodes: [event.target], removedNodes: []});
        },
        true
      );
    }
    function changes(records) {
      dispatched = new Tracker;
      for (var
        record,
        length = records.length,
        i = 0; i < length; i++
      ) {
        record = records[i];
        dispatchAll(record.removedNodes, DISCONNECTED, CONNECTED);
        dispatchAll(record.addedNodes, CONNECTED, DISCONNECTED);
      }
      dispatched = null;
    }
    function dispatchAll(nodes, type, counter) {
      for (var
        node,
        event = new Event(type),
        length = nodes.length,
        i = 0; i < length;
        (node = nodes[i++]).nodeType === 1 &&
        dispatchTarget(node, event, type, counter)
      );
    }
    function dispatchTarget(node, event, type, counter) {
      if (observer.has(node) && !dispatched[type].has(node)) {
        dispatched[counter].delete(node);
        dispatched[type].add(node);
        node.dispatchEvent(event);
        /*
        // The event is not bubbling (perf reason: should it?),
        // hence there's no way to know if
        // stop/Immediate/Propagation() was called.
        // Should DOM Level 0 work at all?
        // I say it's a YAGNI case for the time being,
        // and easy to implement in user-land.
        if (!event.cancelBubble) {
          var fn = node['on' + type];
          if (fn)
            fn.call(node, event);
        }
        */
      }
      for (var
        // apparently is node.children || IE11 ... ^_^;;
        // https://github.com/WebReflection/disconnected/issues/1
        children = node.children || [],
        length = children.length,
        i = 0; i < length;
        dispatchTarget(children[i++], event, type, counter)
      );
    }
    function Tracker() {
      this[CONNECTED] = new WeakSet;
      this[DISCONNECTED] = new WeakSet;
    }
  }
}
module.exports = disconnected;

},{}],24:[function(require,module,exports){
/*!
ISC License

Copyright (c) 2014-2018, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

*/
// global window Object
// optional polyfill info
//    'auto' used by default, everything is feature detected
//    'force' use the polyfill even if not fully needed
function installCustomElements(window, polyfill) {'use strict';

  // DO NOT USE THIS FILE DIRECTLY, IT WON'T WORK
  // THIS IS A PROJECT BASED ON A BUILD SYSTEM
  // THIS FILE IS JUST WRAPPED UP RESULTING IN
  // build/document-register-element.node.js

  var
    document = window.document,
    Object = window.Object
  ;

  var htmlClass = (function (info) {
    // (C) Andrea Giammarchi - @WebReflection - MIT Style
    var
      catchClass = /^[A-Z]+[a-z]/,
      filterBy = function (re) {
        var arr = [], tag;
        for (tag in register) {
          if (re.test(tag)) arr.push(tag);
        }
        return arr;
      },
      add = function (Class, tag) {
        tag = tag.toLowerCase();
        if (!(tag in register)) {
          register[Class] = (register[Class] || []).concat(tag);
          register[tag] = (register[tag.toUpperCase()] = Class);
        }
      },
      register = (Object.create || Object)(null),
      htmlClass = {},
      i, section, tags, Class
    ;
    for (section in info) {
      for (Class in info[section]) {
        tags = info[section][Class];
        register[Class] = tags;
        for (i = 0; i < tags.length; i++) {
          register[tags[i].toLowerCase()] =
          register[tags[i].toUpperCase()] = Class;
        }
      }
    }
    htmlClass.get = function get(tagOrClass) {
      return typeof tagOrClass === 'string' ?
        (register[tagOrClass] || (catchClass.test(tagOrClass) ? [] : '')) :
        filterBy(tagOrClass);
    };
    htmlClass.set = function set(tag, Class) {
      return (catchClass.test(tag) ?
        add(tag, Class) :
        add(Class, tag)
      ), htmlClass;
    };
    return htmlClass;
  }({
    "collections": {
      "HTMLAllCollection": [
        "all"
      ],
      "HTMLCollection": [
        "forms"
      ],
      "HTMLFormControlsCollection": [
        "elements"
      ],
      "HTMLOptionsCollection": [
        "options"
      ]
    },
    "elements": {
      "Element": [
        "element"
      ],
      "HTMLAnchorElement": [
        "a"
      ],
      "HTMLAppletElement": [
        "applet"
      ],
      "HTMLAreaElement": [
        "area"
      ],
      "HTMLAttachmentElement": [
        "attachment"
      ],
      "HTMLAudioElement": [
        "audio"
      ],
      "HTMLBRElement": [
        "br"
      ],
      "HTMLBaseElement": [
        "base"
      ],
      "HTMLBodyElement": [
        "body"
      ],
      "HTMLButtonElement": [
        "button"
      ],
      "HTMLCanvasElement": [
        "canvas"
      ],
      "HTMLContentElement": [
        "content"
      ],
      "HTMLDListElement": [
        "dl"
      ],
      "HTMLDataElement": [
        "data"
      ],
      "HTMLDataListElement": [
        "datalist"
      ],
      "HTMLDetailsElement": [
        "details"
      ],
      "HTMLDialogElement": [
        "dialog"
      ],
      "HTMLDirectoryElement": [
        "dir"
      ],
      "HTMLDivElement": [
        "div"
      ],
      "HTMLDocument": [
        "document"
      ],
      "HTMLElement": [
        "element",
        "abbr",
        "address",
        "article",
        "aside",
        "b",
        "bdi",
        "bdo",
        "cite",
        "code",
        "command",
        "dd",
        "dfn",
        "dt",
        "em",
        "figcaption",
        "figure",
        "footer",
        "header",
        "i",
        "kbd",
        "mark",
        "nav",
        "noscript",
        "rp",
        "rt",
        "ruby",
        "s",
        "samp",
        "section",
        "small",
        "strong",
        "sub",
        "summary",
        "sup",
        "u",
        "var",
        "wbr"
      ],
      "HTMLEmbedElement": [
        "embed"
      ],
      "HTMLFieldSetElement": [
        "fieldset"
      ],
      "HTMLFontElement": [
        "font"
      ],
      "HTMLFormElement": [
        "form"
      ],
      "HTMLFrameElement": [
        "frame"
      ],
      "HTMLFrameSetElement": [
        "frameset"
      ],
      "HTMLHRElement": [
        "hr"
      ],
      "HTMLHeadElement": [
        "head"
      ],
      "HTMLHeadingElement": [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6"
      ],
      "HTMLHtmlElement": [
        "html"
      ],
      "HTMLIFrameElement": [
        "iframe"
      ],
      "HTMLImageElement": [
        "img"
      ],
      "HTMLInputElement": [
        "input"
      ],
      "HTMLKeygenElement": [
        "keygen"
      ],
      "HTMLLIElement": [
        "li"
      ],
      "HTMLLabelElement": [
        "label"
      ],
      "HTMLLegendElement": [
        "legend"
      ],
      "HTMLLinkElement": [
        "link"
      ],
      "HTMLMapElement": [
        "map"
      ],
      "HTMLMarqueeElement": [
        "marquee"
      ],
      "HTMLMediaElement": [
        "media"
      ],
      "HTMLMenuElement": [
        "menu"
      ],
      "HTMLMenuItemElement": [
        "menuitem"
      ],
      "HTMLMetaElement": [
        "meta"
      ],
      "HTMLMeterElement": [
        "meter"
      ],
      "HTMLModElement": [
        "del",
        "ins"
      ],
      "HTMLOListElement": [
        "ol"
      ],
      "HTMLObjectElement": [
        "object"
      ],
      "HTMLOptGroupElement": [
        "optgroup"
      ],
      "HTMLOptionElement": [
        "option"
      ],
      "HTMLOutputElement": [
        "output"
      ],
      "HTMLParagraphElement": [
        "p"
      ],
      "HTMLParamElement": [
        "param"
      ],
      "HTMLPictureElement": [
        "picture"
      ],
      "HTMLPreElement": [
        "pre"
      ],
      "HTMLProgressElement": [
        "progress"
      ],
      "HTMLQuoteElement": [
        "blockquote",
        "q",
        "quote"
      ],
      "HTMLScriptElement": [
        "script"
      ],
      "HTMLSelectElement": [
        "select"
      ],
      "HTMLShadowElement": [
        "shadow"
      ],
      "HTMLSlotElement": [
        "slot"
      ],
      "HTMLSourceElement": [
        "source"
      ],
      "HTMLSpanElement": [
        "span"
      ],
      "HTMLStyleElement": [
        "style"
      ],
      "HTMLTableCaptionElement": [
        "caption"
      ],
      "HTMLTableCellElement": [
        "td",
        "th"
      ],
      "HTMLTableColElement": [
        "col",
        "colgroup"
      ],
      "HTMLTableElement": [
        "table"
      ],
      "HTMLTableRowElement": [
        "tr"
      ],
      "HTMLTableSectionElement": [
        "thead",
        "tbody",
        "tfoot"
      ],
      "HTMLTemplateElement": [
        "template"
      ],
      "HTMLTextAreaElement": [
        "textarea"
      ],
      "HTMLTimeElement": [
        "time"
      ],
      "HTMLTitleElement": [
        "title"
      ],
      "HTMLTrackElement": [
        "track"
      ],
      "HTMLUListElement": [
        "ul"
      ],
      "HTMLUnknownElement": [
        "unknown",
        "vhgroupv",
        "vkeygen"
      ],
      "HTMLVideoElement": [
        "video"
      ]
    },
    "nodes": {
      "Attr": [
        "node"
      ],
      "Audio": [
        "audio"
      ],
      "CDATASection": [
        "node"
      ],
      "CharacterData": [
        "node"
      ],
      "Comment": [
        "#comment"
      ],
      "Document": [
        "#document"
      ],
      "DocumentFragment": [
        "#document-fragment"
      ],
      "DocumentType": [
        "node"
      ],
      "HTMLDocument": [
        "#document"
      ],
      "Image": [
        "img"
      ],
      "Option": [
        "option"
      ],
      "ProcessingInstruction": [
        "node"
      ],
      "ShadowRoot": [
        "#shadow-root"
      ],
      "Text": [
        "#text"
      ],
      "XMLDocument": [
        "xml"
      ]
    }
  }));
  
  
    
  // passed at runtime, configurable via nodejs module
  if (typeof polyfill !== 'object') polyfill = {type: polyfill || 'auto'};
  
  var
    // V0 polyfill entry
    REGISTER_ELEMENT = 'registerElement',
  
    // IE < 11 only + old WebKit for attributes + feature detection
    EXPANDO_UID = '__' + REGISTER_ELEMENT + (window.Math.random() * 10e4 >> 0),
  
    // shortcuts and costants
    ADD_EVENT_LISTENER = 'addEventListener',
    ATTACHED = 'attached',
    CALLBACK = 'Callback',
    DETACHED = 'detached',
    EXTENDS = 'extends',
  
    ATTRIBUTE_CHANGED_CALLBACK = 'attributeChanged' + CALLBACK,
    ATTACHED_CALLBACK = ATTACHED + CALLBACK,
    CONNECTED_CALLBACK = 'connected' + CALLBACK,
    DISCONNECTED_CALLBACK = 'disconnected' + CALLBACK,
    CREATED_CALLBACK = 'created' + CALLBACK,
    DETACHED_CALLBACK = DETACHED + CALLBACK,
  
    ADDITION = 'ADDITION',
    MODIFICATION = 'MODIFICATION',
    REMOVAL = 'REMOVAL',
  
    DOM_ATTR_MODIFIED = 'DOMAttrModified',
    DOM_CONTENT_LOADED = 'DOMContentLoaded',
    DOM_SUBTREE_MODIFIED = 'DOMSubtreeModified',
  
    PREFIX_TAG = '<',
    PREFIX_IS = '=',
  
    // valid and invalid node names
    validName = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/,
    invalidNames = [
      'ANNOTATION-XML',
      'COLOR-PROFILE',
      'FONT-FACE',
      'FONT-FACE-SRC',
      'FONT-FACE-URI',
      'FONT-FACE-FORMAT',
      'FONT-FACE-NAME',
      'MISSING-GLYPH'
    ],
  
    // registered types and their prototypes
    types = [],
    protos = [],
  
    // to query subnodes
    query = '',
  
    // html shortcut used to feature detect
    documentElement = document.documentElement,
  
    // ES5 inline helpers || basic patches
    indexOf = types.indexOf || function (v) {
      for(var i = this.length; i-- && this[i] !== v;){}
      return i;
    },
  
    // other helpers / shortcuts
    OP = Object.prototype,
    hOP = OP.hasOwnProperty,
    iPO = OP.isPrototypeOf,
  
    defineProperty = Object.defineProperty,
    empty = [],
    gOPD = Object.getOwnPropertyDescriptor,
    gOPN = Object.getOwnPropertyNames,
    gPO = Object.getPrototypeOf,
    sPO = Object.setPrototypeOf,
  
    // jshint proto: true
    hasProto = !!Object.__proto__,
  
    // V1 helpers
    fixGetClass = false,
    DRECEV1 = '__dreCEv1',
    customElements = window.customElements,
    usableCustomElements = !/^force/.test(polyfill.type) && !!(
      customElements &&
      customElements.define &&
      customElements.get &&
      customElements.whenDefined
    ),
    Dict = Object.create || Object,
    Map = window.Map || function Map() {
      var K = [], V = [], i;
      return {
        get: function (k) {
          return V[indexOf.call(K, k)];
        },
        set: function (k, v) {
          i = indexOf.call(K, k);
          if (i < 0) V[K.push(k) - 1] = v;
          else V[i] = v;
        }
      };
    },
    Promise = window.Promise || function (fn) {
      var
        notify = [],
        done = false,
        p = {
          'catch': function () {
            return p;
          },
          'then': function (cb) {
            notify.push(cb);
            if (done) setTimeout(resolve, 1);
            return p;
          }
        }
      ;
      function resolve(value) {
        done = true;
        while (notify.length) notify.shift()(value);
      }
      fn(resolve);
      return p;
    },
    justCreated = false,
    constructors = Dict(null),
    waitingList = Dict(null),
    nodeNames = new Map(),
    secondArgument = function (is) {
      return is.toLowerCase();
    },
  
    // used to create unique instances
    create = Object.create || function Bridge(proto) {
      // silly broken polyfill probably ever used but short enough to work
      return proto ? ((Bridge.prototype = proto), new Bridge()) : this;
    },
  
    // will set the prototype if possible
    // or copy over all properties
    setPrototype = sPO || (
      hasProto ?
        function (o, p) {
          o.__proto__ = p;
          return o;
        } : (
      (gOPN && gOPD) ?
        (function(){
          function setProperties(o, p) {
            for (var
              key,
              names = gOPN(p),
              i = 0, length = names.length;
              i < length; i++
            ) {
              key = names[i];
              if (!hOP.call(o, key)) {
                defineProperty(o, key, gOPD(p, key));
              }
            }
          }
          return function (o, p) {
            do {
              setProperties(o, p);
            } while ((p = gPO(p)) && !iPO.call(p, o));
            return o;
          };
        }()) :
        function (o, p) {
          for (var key in p) {
            o[key] = p[key];
          }
          return o;
        }
    )),
  
    // DOM shortcuts and helpers, if any
  
    MutationObserver = window.MutationObserver ||
                       window.WebKitMutationObserver,
  
    HTMLAnchorElement = window.HTMLAnchorElement,
  
    HTMLElementPrototype = (
      window.HTMLElement ||
      window.Element ||
      window.Node
    ).prototype,
  
    IE8 = !iPO.call(HTMLElementPrototype, documentElement),
  
    safeProperty = IE8 ? function (o, k, d) {
      o[k] = d.value;
      return o;
    } : defineProperty,
  
    isValidNode = IE8 ?
      function (node) {
        return node.nodeType === 1;
      } :
      function (node) {
        return iPO.call(HTMLElementPrototype, node);
      },
  
    targets = IE8 && [],
  
    attachShadow = HTMLElementPrototype.attachShadow,
    cloneNode = HTMLElementPrototype.cloneNode,
    dispatchEvent = HTMLElementPrototype.dispatchEvent,
    getAttribute = HTMLElementPrototype.getAttribute,
    hasAttribute = HTMLElementPrototype.hasAttribute,
    removeAttribute = HTMLElementPrototype.removeAttribute,
    setAttribute = HTMLElementPrototype.setAttribute,
  
    // replaced later on
    createElement = document.createElement,
    importNode = document.importNode,
    patchedCreateElement = createElement,
  
    // shared observer for all attributes
    attributesObserver = MutationObserver && {
      attributes: true,
      characterData: true,
      attributeOldValue: true
    },
  
    // useful to detect only if there's no MutationObserver
    DOMAttrModified = MutationObserver || function(e) {
      doesNotSupportDOMAttrModified = false;
      documentElement.removeEventListener(
        DOM_ATTR_MODIFIED,
        DOMAttrModified
      );
    },
  
    // will both be used to make DOMNodeInserted asynchronous
    asapQueue,
    asapTimer = 0,
  
    // internal flags
    V0 = REGISTER_ELEMENT in document &&
         !/^force-all/.test(polyfill.type),
    setListener = true,
    justSetup = false,
    doesNotSupportDOMAttrModified = true,
    dropDomContentLoaded = true,
  
    // needed for the innerHTML helper
    notFromInnerHTMLHelper = true,
  
    // optionally defined later on
    onSubtreeModified,
    callDOMAttrModified,
    getAttributesMirror,
    observer,
    observe,
  
    // based on setting prototype capability
    // will check proto or the expando attribute
    // in order to setup the node once
    patchIfNotAlready,
    patch,
  
    // used for tests
    tmp
  ;
  
  // IE11 disconnectedCallback issue #
  // to be tested before any createElement patch
  if (MutationObserver) {
    // original fix:
    // https://github.com/javan/mutation-observer-inner-html-shim
    tmp = document.createElement('div');
    tmp.innerHTML = '<div><div></div></div>';
    new MutationObserver(function (mutations, observer) {
      if (
        mutations[0] &&
        mutations[0].type == 'childList' &&
        !mutations[0].removedNodes[0].childNodes.length
      ) {
        tmp = gOPD(HTMLElementPrototype, 'innerHTML');
        var set = tmp && tmp.set;
        if (set)
          defineProperty(HTMLElementPrototype, 'innerHTML', {
            set: function (value) {
              while (this.lastChild)
                this.removeChild(this.lastChild);
              set.call(this, value);
            }
          });
      }
      observer.disconnect();
      tmp = null;
    }).observe(tmp, {childList: true, subtree: true});
    tmp.innerHTML = "";
  }
  
  // only if needed
  if (!V0) {
  
    if (sPO || hasProto) {
        patchIfNotAlready = function (node, proto) {
          if (!iPO.call(proto, node)) {
            setupNode(node, proto);
          }
        };
        patch = setupNode;
    } else {
        patchIfNotAlready = function (node, proto) {
          if (!node[EXPANDO_UID]) {
            node[EXPANDO_UID] = Object(true);
            setupNode(node, proto);
          }
        };
        patch = patchIfNotAlready;
    }
  
    if (IE8) {
      doesNotSupportDOMAttrModified = false;
      (function (){
        var
          descriptor = gOPD(HTMLElementPrototype, ADD_EVENT_LISTENER),
          addEventListener = descriptor.value,
          patchedRemoveAttribute = function (name) {
            var e = new CustomEvent(DOM_ATTR_MODIFIED, {bubbles: true});
            e.attrName = name;
            e.prevValue = getAttribute.call(this, name);
            e.newValue = null;
            e[REMOVAL] = e.attrChange = 2;
            removeAttribute.call(this, name);
            dispatchEvent.call(this, e);
          },
          patchedSetAttribute = function (name, value) {
            var
              had = hasAttribute.call(this, name),
              old = had && getAttribute.call(this, name),
              e = new CustomEvent(DOM_ATTR_MODIFIED, {bubbles: true})
            ;
            setAttribute.call(this, name, value);
            e.attrName = name;
            e.prevValue = had ? old : null;
            e.newValue = value;
            if (had) {
              e[MODIFICATION] = e.attrChange = 1;
            } else {
              e[ADDITION] = e.attrChange = 0;
            }
            dispatchEvent.call(this, e);
          },
          onPropertyChange = function (e) {
            // jshint eqnull:true
            var
              node = e.currentTarget,
              superSecret = node[EXPANDO_UID],
              propertyName = e.propertyName,
              event
            ;
            if (superSecret.hasOwnProperty(propertyName)) {
              superSecret = superSecret[propertyName];
              event = new CustomEvent(DOM_ATTR_MODIFIED, {bubbles: true});
              event.attrName = superSecret.name;
              event.prevValue = superSecret.value || null;
              event.newValue = (superSecret.value = node[propertyName] || null);
              if (event.prevValue == null) {
                event[ADDITION] = event.attrChange = 0;
              } else {
                event[MODIFICATION] = event.attrChange = 1;
              }
              dispatchEvent.call(node, event);
            }
          }
        ;
        descriptor.value = function (type, handler, capture) {
          if (
            type === DOM_ATTR_MODIFIED &&
            this[ATTRIBUTE_CHANGED_CALLBACK] &&
            this.setAttribute !== patchedSetAttribute
          ) {
            this[EXPANDO_UID] = {
              className: {
                name: 'class',
                value: this.className
              }
            };
            this.setAttribute = patchedSetAttribute;
            this.removeAttribute = patchedRemoveAttribute;
            addEventListener.call(this, 'propertychange', onPropertyChange);
          }
          addEventListener.call(this, type, handler, capture);
        };
        defineProperty(HTMLElementPrototype, ADD_EVENT_LISTENER, descriptor);
      }());
    } else if (!MutationObserver) {
      documentElement[ADD_EVENT_LISTENER](DOM_ATTR_MODIFIED, DOMAttrModified);
      documentElement.setAttribute(EXPANDO_UID, 1);
      documentElement.removeAttribute(EXPANDO_UID);
      if (doesNotSupportDOMAttrModified) {
        onSubtreeModified = function (e) {
          var
            node = this,
            oldAttributes,
            newAttributes,
            key
          ;
          if (node === e.target) {
            oldAttributes = node[EXPANDO_UID];
            node[EXPANDO_UID] = (newAttributes = getAttributesMirror(node));
            for (key in newAttributes) {
              if (!(key in oldAttributes)) {
                // attribute was added
                return callDOMAttrModified(
                  0,
                  node,
                  key,
                  oldAttributes[key],
                  newAttributes[key],
                  ADDITION
                );
              } else if (newAttributes[key] !== oldAttributes[key]) {
                // attribute was changed
                return callDOMAttrModified(
                  1,
                  node,
                  key,
                  oldAttributes[key],
                  newAttributes[key],
                  MODIFICATION
                );
              }
            }
            // checking if it has been removed
            for (key in oldAttributes) {
              if (!(key in newAttributes)) {
                // attribute removed
                return callDOMAttrModified(
                  2,
                  node,
                  key,
                  oldAttributes[key],
                  newAttributes[key],
                  REMOVAL
                );
              }
            }
          }
        };
        callDOMAttrModified = function (
          attrChange,
          currentTarget,
          attrName,
          prevValue,
          newValue,
          action
        ) {
          var e = {
            attrChange: attrChange,
            currentTarget: currentTarget,
            attrName: attrName,
            prevValue: prevValue,
            newValue: newValue
          };
          e[action] = attrChange;
          onDOMAttrModified(e);
        };
        getAttributesMirror = function (node) {
          for (var
            attr, name,
            result = {},
            attributes = node.attributes,
            i = 0, length = attributes.length;
            i < length; i++
          ) {
            attr = attributes[i];
            name = attr.name;
            if (name !== 'setAttribute') {
              result[name] = attr.value;
            }
          }
          return result;
        };
      }
    }
  
    // set as enumerable, writable and configurable
    document[REGISTER_ELEMENT] = function registerElement(type, options) {
      upperType = type.toUpperCase();
      if (setListener) {
        // only first time document.registerElement is used
        // we need to set this listener
        // setting it by default might slow down for no reason
        setListener = false;
        if (MutationObserver) {
          observer = (function(attached, detached){
            function checkEmAll(list, callback) {
              for (var i = 0, length = list.length; i < length; callback(list[i++])){}
            }
            return new MutationObserver(function (records) {
              for (var
                current, node, newValue,
                i = 0, length = records.length; i < length; i++
              ) {
                current = records[i];
                if (current.type === 'childList') {
                  checkEmAll(current.addedNodes, attached);
                  checkEmAll(current.removedNodes, detached);
                } else {
                  node = current.target;
                  if (notFromInnerHTMLHelper &&
                      node[ATTRIBUTE_CHANGED_CALLBACK] &&
                      current.attributeName !== 'style') {
                    newValue = getAttribute.call(node, current.attributeName);
                    if (newValue !== current.oldValue) {
                      node[ATTRIBUTE_CHANGED_CALLBACK](
                        current.attributeName,
                        current.oldValue,
                        newValue
                      );
                    }
                  }
                }
              }
            });
          }(executeAction(ATTACHED), executeAction(DETACHED)));
          observe = function (node) {
            observer.observe(
              node,
              {
                childList: true,
                subtree: true
              }
            );
            return node;
          };
          observe(document);
          if (attachShadow) {
            HTMLElementPrototype.attachShadow = function () {
              return observe(attachShadow.apply(this, arguments));
            };
          }
        } else {
          asapQueue = [];
          document[ADD_EVENT_LISTENER]('DOMNodeInserted', onDOMNode(ATTACHED));
          document[ADD_EVENT_LISTENER]('DOMNodeRemoved', onDOMNode(DETACHED));
        }
  
        document[ADD_EVENT_LISTENER](DOM_CONTENT_LOADED, onReadyStateChange);
        document[ADD_EVENT_LISTENER]('readystatechange', onReadyStateChange);
  
        document.importNode = function (node, deep) {
          switch (node.nodeType) {
            case 1:
              return setupAll(document, importNode, [node, !!deep]);
            case 11:
              for (var
                fragment = document.createDocumentFragment(),
                childNodes = node.childNodes,
                length = childNodes.length,
                i = 0; i < length; i++
              )
                fragment.appendChild(document.importNode(childNodes[i], !!deep));
              return fragment;
            default:
              return cloneNode.call(node, !!deep);
          }
        };
  
        HTMLElementPrototype.cloneNode = function (deep) {
          return setupAll(this, cloneNode, [!!deep]);
        };
      }
  
      if (justSetup) return (justSetup = false);
  
      if (-2 < (
        indexOf.call(types, PREFIX_IS + upperType) +
        indexOf.call(types, PREFIX_TAG + upperType)
      )) {
        throwTypeError(type);
      }
  
      if (!validName.test(upperType) || -1 < indexOf.call(invalidNames, upperType)) {
        throw new Error('The type ' + type + ' is invalid');
      }
  
      var
        constructor = function () {
          return extending ?
            document.createElement(nodeName, upperType) :
            document.createElement(nodeName);
        },
        opt = options || OP,
        extending = hOP.call(opt, EXTENDS),
        nodeName = extending ? options[EXTENDS].toUpperCase() : upperType,
        upperType,
        i
      ;
  
      if (extending && -1 < (
        indexOf.call(types, PREFIX_TAG + nodeName)
      )) {
        throwTypeError(nodeName);
      }
  
      i = types.push((extending ? PREFIX_IS : PREFIX_TAG) + upperType) - 1;
  
      query = query.concat(
        query.length ? ',' : '',
        extending ? nodeName + '[is="' + type.toLowerCase() + '"]' : nodeName
      );
  
      constructor.prototype = (
        protos[i] = hOP.call(opt, 'prototype') ?
          opt.prototype :
          create(HTMLElementPrototype)
      );
  
      if (query.length) loopAndVerify(
        document.querySelectorAll(query),
        ATTACHED
      );
  
      return constructor;
    };
  
    document.createElement = (patchedCreateElement = function (localName, typeExtension) {
      var
        is = getIs(typeExtension),
        node = is ?
          createElement.call(document, localName, secondArgument(is)) :
          createElement.call(document, localName),
        name = '' + localName,
        i = indexOf.call(
          types,
          (is ? PREFIX_IS : PREFIX_TAG) +
          (is || name).toUpperCase()
        ),
        setup = -1 < i
      ;
      if (is) {
        node.setAttribute('is', is = is.toLowerCase());
        if (setup) {
          setup = isInQSA(name.toUpperCase(), is);
        }
      }
      notFromInnerHTMLHelper = !document.createElement.innerHTMLHelper;
      if (setup) patch(node, protos[i]);
      return node;
    });
  
  }
  
  function ASAP() {
    var queue = asapQueue.splice(0, asapQueue.length);
    asapTimer = 0;
    while (queue.length) {
      queue.shift().call(
        null, queue.shift()
      );
    }
  }
  
  function loopAndVerify(list, action) {
    for (var i = 0, length = list.length; i < length; i++) {
      verifyAndSetupAndAction(list[i], action);
    }
  }
  
  function loopAndSetup(list) {
    for (var i = 0, length = list.length, node; i < length; i++) {
      node = list[i];
      patch(node, protos[getTypeIndex(node)]);
    }
  }
  
  function executeAction(action) {
    return function (node) {
      if (isValidNode(node)) {
        verifyAndSetupAndAction(node, action);
        if (query.length) loopAndVerify(
          node.querySelectorAll(query),
          action
        );
      }
    };
  }
  
  function getTypeIndex(target) {
    var
      is = getAttribute.call(target, 'is'),
      nodeName = target.nodeName.toUpperCase(),
      i = indexOf.call(
        types,
        is ?
            PREFIX_IS + is.toUpperCase() :
            PREFIX_TAG + nodeName
      )
    ;
    return is && -1 < i && !isInQSA(nodeName, is) ? -1 : i;
  }
  
  function isInQSA(name, type) {
    return -1 < query.indexOf(name + '[is="' + type + '"]');
  }
  
  function onDOMAttrModified(e) {
    var
      node = e.currentTarget,
      attrChange = e.attrChange,
      attrName = e.attrName,
      target = e.target,
      addition = e[ADDITION] || 2,
      removal = e[REMOVAL] || 3
    ;
    if (notFromInnerHTMLHelper &&
        (!target || target === node) &&
        node[ATTRIBUTE_CHANGED_CALLBACK] &&
        attrName !== 'style' && (
          e.prevValue !== e.newValue ||
          // IE9, IE10, and Opera 12 gotcha
          e.newValue === '' && (
            attrChange === addition ||
            attrChange === removal
          )
    )) {
      node[ATTRIBUTE_CHANGED_CALLBACK](
        attrName,
        attrChange === addition ? null : e.prevValue,
        attrChange === removal ? null : e.newValue
      );
    }
  }
  
  function onDOMNode(action) {
    var executor = executeAction(action);
    return function (e) {
      asapQueue.push(executor, e.target);
      if (asapTimer) clearTimeout(asapTimer);
      asapTimer = setTimeout(ASAP, 1);
    };
  }
  
  function onReadyStateChange(e) {
    if (dropDomContentLoaded) {
      dropDomContentLoaded = false;
      e.currentTarget.removeEventListener(DOM_CONTENT_LOADED, onReadyStateChange);
    }
    if (query.length) loopAndVerify(
      (e.target || document).querySelectorAll(query),
      e.detail === DETACHED ? DETACHED : ATTACHED
    );
    if (IE8) purge();
  }
  
  function patchedSetAttribute(name, value) {
    // jshint validthis:true
    var self = this;
    setAttribute.call(self, name, value);
    onSubtreeModified.call(self, {target: self});
  }
  
  function setupAll(context, callback, args) {
    var
      node = callback.apply(context, args),
      i = getTypeIndex(node)
    ;
    if (-1 < i) patch(node, protos[i]);
    if (args.pop() && query.length)
      loopAndSetup(node.querySelectorAll(query));
    return node;
  }
  
  function setupNode(node, proto) {
    setPrototype(node, proto);
    if (observer) {
      observer.observe(node, attributesObserver);
    } else {
      if (doesNotSupportDOMAttrModified) {
        node.setAttribute = patchedSetAttribute;
        node[EXPANDO_UID] = getAttributesMirror(node);
        node[ADD_EVENT_LISTENER](DOM_SUBTREE_MODIFIED, onSubtreeModified);
      }
      node[ADD_EVENT_LISTENER](DOM_ATTR_MODIFIED, onDOMAttrModified);
    }
    if (node[CREATED_CALLBACK] && notFromInnerHTMLHelper) {
      node.created = true;
      node[CREATED_CALLBACK]();
      node.created = false;
    }
  }
  
  function purge() {
    for (var
      node,
      i = 0,
      length = targets.length;
      i < length; i++
    ) {
      node = targets[i];
      if (!documentElement.contains(node)) {
        length--;
        targets.splice(i--, 1);
        verifyAndSetupAndAction(node, DETACHED);
      }
    }
  }
  
  function throwTypeError(type) {
    throw new Error('A ' + type + ' type is already registered');
  }
  
  function verifyAndSetupAndAction(node, action) {
    var
      fn,
      i = getTypeIndex(node),
      counterAction
    ;
    if (-1 < i) {
      patchIfNotAlready(node, protos[i]);
      i = 0;
      if (action === ATTACHED && !node[ATTACHED]) {
        node[DETACHED] = false;
        node[ATTACHED] = true;
        counterAction = 'connected';
        i = 1;
        if (IE8 && indexOf.call(targets, node) < 0) {
          targets.push(node);
        }
      } else if (action === DETACHED && !node[DETACHED]) {
        node[ATTACHED] = false;
        node[DETACHED] = true;
        counterAction = 'disconnected';
        i = 1;
      }
      if (i && (fn = (
        node[action + CALLBACK] ||
        node[counterAction + CALLBACK]
      ))) fn.call(node);
    }
  }
  
  
  
  // V1 in da House!
  function CustomElementRegistry() {}
  
  CustomElementRegistry.prototype = {
    constructor: CustomElementRegistry,
    // a workaround for the stubborn WebKit
    define: usableCustomElements ?
      function (name, Class, options) {
        if (options) {
          CERDefine(name, Class, options);
        } else {
          var NAME = name.toUpperCase();
          constructors[NAME] = {
            constructor: Class,
            create: [NAME]
          };
          nodeNames.set(Class, NAME);
          customElements.define(name, Class);
        }
      } :
      CERDefine,
    get: usableCustomElements ?
      function (name) {
        return customElements.get(name) || get(name);
      } :
      get,
    whenDefined: usableCustomElements ?
      function (name) {
        return Promise.race([
          customElements.whenDefined(name),
          whenDefined(name)
        ]);
      } :
      whenDefined
  };
  
  function CERDefine(name, Class, options) {
    var
      is = options && options[EXTENDS] || '',
      CProto = Class.prototype,
      proto = create(CProto),
      attributes = Class.observedAttributes || empty,
      definition = {prototype: proto}
    ;
    // TODO: is this needed at all since it's inherited?
    // defineProperty(proto, 'constructor', {value: Class});
    safeProperty(proto, CREATED_CALLBACK, {
        value: function () {
          if (justCreated) justCreated = false;
          else if (!this[DRECEV1]) {
            this[DRECEV1] = true;
            new Class(this);
            if (CProto[CREATED_CALLBACK])
              CProto[CREATED_CALLBACK].call(this);
            var info = constructors[nodeNames.get(Class)];
            if (!usableCustomElements || info.create.length > 1) {
              notifyAttributes(this);
            }
          }
      }
    });
    safeProperty(proto, ATTRIBUTE_CHANGED_CALLBACK, {
      value: function (name) {
        if (-1 < indexOf.call(attributes, name)) {
          if (CProto[ATTRIBUTE_CHANGED_CALLBACK])
            CProto[ATTRIBUTE_CHANGED_CALLBACK].apply(this, arguments);
        }
      }
    });
    if (CProto[CONNECTED_CALLBACK]) {
      safeProperty(proto, ATTACHED_CALLBACK, {
        value: CProto[CONNECTED_CALLBACK]
      });
    }
    if (CProto[DISCONNECTED_CALLBACK]) {
      safeProperty(proto, DETACHED_CALLBACK, {
        value: CProto[DISCONNECTED_CALLBACK]
      });
    }
    if (is) definition[EXTENDS] = is;
    name = name.toUpperCase();
    constructors[name] = {
      constructor: Class,
      create: is ? [is, secondArgument(name)] : [name]
    };
    nodeNames.set(Class, name);
    document[REGISTER_ELEMENT](name.toLowerCase(), definition);
    whenDefined(name);
    waitingList[name].r();
  }
  
  function get(name) {
    var info = constructors[name.toUpperCase()];
    return info && info.constructor;
  }
  
  function getIs(options) {
    return typeof options === 'string' ?
        options : (options && options.is || '');
  }
  
  function notifyAttributes(self) {
    var
      callback = self[ATTRIBUTE_CHANGED_CALLBACK],
      attributes = callback ? self.attributes : empty,
      i = attributes.length,
      attribute
    ;
    while (i--) {
      attribute =  attributes[i]; // || attributes.item(i);
      callback.call(
        self,
        attribute.name || attribute.nodeName,
        null,
        attribute.value || attribute.nodeValue
      );
    }
  }
  
  function whenDefined(name) {
    name = name.toUpperCase();
    if (!(name in waitingList)) {
      waitingList[name] = {};
      waitingList[name].p = new Promise(function (resolve) {
        waitingList[name].r = resolve;
      });
    }
    return waitingList[name].p;
  }
  
  function polyfillV1() {
    if (customElements) delete window.customElements;
    defineProperty(window, 'customElements', {
      configurable: true,
      value: new CustomElementRegistry()
    });
    defineProperty(window, 'CustomElementRegistry', {
      configurable: true,
      value: CustomElementRegistry
    });
    for (var
      patchClass = function (name) {
        var Class = window[name];
        if (Class) {
          window[name] = function CustomElementsV1(self) {
            var info, isNative;
            if (!self) self = this;
            if (!self[DRECEV1]) {
              justCreated = true;
              info = constructors[nodeNames.get(self.constructor)];
              isNative = usableCustomElements && info.create.length === 1;
              self = isNative ?
                Reflect.construct(Class, empty, info.constructor) :
                document.createElement.apply(document, info.create);
              self[DRECEV1] = true;
              justCreated = false;
              if (!isNative) notifyAttributes(self);
            }
            return self;
          };
          window[name].prototype = Class.prototype;
          try {
            Class.prototype.constructor = window[name];
          } catch(WebKit) {
            fixGetClass = true;
            defineProperty(Class, DRECEV1, {value: window[name]});
          }
        }
      },
      Classes = htmlClass.get(/^HTML[A-Z]*[a-z]/),
      i = Classes.length;
      i--;
      patchClass(Classes[i])
    ) {}
    (document.createElement = function (name, options) {
      var is = getIs(options);
      return is ?
        patchedCreateElement.call(this, name, secondArgument(is)) :
        patchedCreateElement.call(this, name);
    });
    if (!V0) {
      justSetup = true;
      document[REGISTER_ELEMENT]('');
    }
  }
  
  // if customElements is not there at all
  if (!customElements || /^force/.test(polyfill.type)) polyfillV1();
  else if(!polyfill.noBuiltIn) {
    // if available test extends work as expected
    try {
      (function (DRE, options, name) {
        var re = new RegExp('^<a\\s+is=(\'|")' + name + '\\1></a>$');
        options[EXTENDS] = 'a';
        DRE.prototype = create(HTMLAnchorElement.prototype);
        DRE.prototype.constructor = DRE;
        window.customElements.define(name, DRE, options);
        if (
          !re.test(document.createElement('a', {is: name}).outerHTML) ||
          !re.test((new DRE()).outerHTML)
        ) {
          throw options;
        }
      }(
        function DRE() {
          return Reflect.construct(HTMLAnchorElement, [], DRE);
        },
        {},
        'document-register-element-a'
      ));
    } catch(o_O) {
      // or force the polyfill if not
      // and keep internal original reference
      polyfillV1();
    }
  }
  
  // FireFox only issue
  if(!polyfill.noBuiltIn) {
    try {
      if (createElement.call(document, 'a', 'a').outerHTML.indexOf('is') < 0)
        throw {};
    } catch(FireFox) {
      secondArgument = function (is) {
        return {is: is.toLowerCase()};
      };
    }
  }
  
}

module.exports = installCustomElements;

},{}],25:[function(require,module,exports){
'use strict';
/*! (c) 2018 Andrea Giammarchi (ISC) */

const {
  eqeq, identity, indexOf, isReversed, next, append, remove, smartDiff
} = require('./utils.js');

const domdiff = (
  parentNode,     // where changes happen
  currentNodes,   // Array of current items/nodes
  futureNodes,    // Array of future items/nodes
  options         // optional object with one of the following properties
                  //  before: domNode
                  //  compare(generic, generic) => true if same generic
                  //  node(generic) => Node
) => {
  if (!options)
    options = {};

  const compare = options.compare || eqeq;
  const get = options.node || identity;
  const before = options.before == null ? null : get(options.before, 0);

  const currentLength = currentNodes.length;
  let currentEnd = currentLength;
  let currentStart = 0;

  let futureEnd = futureNodes.length;
  let futureStart = 0;

  // common prefix
  while (
    currentStart < currentEnd &&
    futureStart < futureEnd &&
    compare(currentNodes[currentStart], futureNodes[futureStart])
  ) {
    currentStart++;
    futureStart++;
  }

  // common suffix
  while (
    currentStart < currentEnd &&
    futureStart < futureEnd &&
    compare(currentNodes[currentEnd - 1], futureNodes[futureEnd - 1])
  ) {
    currentEnd--;
    futureEnd--;
  }

  const currentSame = currentStart === currentEnd;
  const futureSame = futureStart === futureEnd;

  // same list
  if (currentSame && futureSame)
    return futureNodes;

  // only stuff to add
  if (currentSame && futureStart < futureEnd) {
    append(
      get,
      parentNode,
      futureNodes,
      futureStart,
      futureEnd,
      next(get, currentNodes, currentStart, currentLength, before)
    );
    return futureNodes;
  }

  // only stuff to remove
  if (futureSame && currentStart < currentEnd) {
    remove(
      get,
      parentNode,
      currentNodes,
      currentStart,
      currentEnd
    );
    return futureNodes;
  }

  const currentChanges = currentEnd - currentStart;
  const futureChanges = futureEnd - futureStart;
  let i = -1;

  // 2 simple indels: the shortest sequence is a subsequence of the longest
  if (currentChanges < futureChanges) {
    i = indexOf(
      futureNodes,
      futureStart,
      futureEnd,
      currentNodes,
      currentStart,
      currentEnd,
      compare
    );
    // inner diff
    if (-1 < i) {
      append(
        get,
        parentNode,
        futureNodes,
        futureStart,
        i,
        get(currentNodes[currentStart], 0)
      );
      append(
        get,
        parentNode,
        futureNodes,
        i + currentChanges,
        futureEnd,
        next(get, currentNodes, currentEnd, currentLength, before)
      );
      return futureNodes;
    }
  }
  /* istanbul ignore else */
  else if (futureChanges < currentChanges) {
    i = indexOf(
      currentNodes,
      currentStart,
      currentEnd,
      futureNodes,
      futureStart,
      futureEnd,
      compare
    );
    // outer diff
    if (-1 < i) {
      remove(
        get,
        parentNode,
        currentNodes,
        currentStart,
        i
      );
      remove(
        get,
        parentNode,
        currentNodes,
        i + futureChanges,
        currentEnd
      );
      return futureNodes;
    }
  }

  // common case with one replacement for many nodes
  // or many nodes replaced for a single one
  /* istanbul ignore else */
  if ((currentChanges < 2 || futureChanges < 2)) {
    append(
      get,
      parentNode,
      futureNodes,
      futureStart,
      futureEnd,
      get(currentNodes[currentStart], 0)
    );
    remove(
      get,
      parentNode,
      currentNodes,
      currentStart,
      currentEnd
    );
    return futureNodes;
  }

  // the half match diff part has been skipped in petit-dom
  // https://github.com/yelouafi/petit-dom/blob/bd6f5c919b5ae5297be01612c524c40be45f14a7/src/vdom.js#L391-L397
  // accordingly, I think it's safe to skip in here too
  // if one day it'll come out like the speediest thing ever to do
  // then I might add it in here too

  // Extra: before going too fancy, what about reversed lists ?
  //        This should bail out pretty quickly if that's not the case.
  if (
    currentChanges === futureChanges &&
    isReversed(
      futureNodes,
      futureEnd,
      currentNodes,
      currentStart,
      currentEnd,
      compare
    )
  ) {
    append(
      get,
      parentNode,
      futureNodes,
      futureStart,
      futureEnd,
      next(get, currentNodes, currentEnd, currentLength, before)
    );
    return futureNodes;
  }

  // last resort through a smart diff
  smartDiff(
    get,
    parentNode,
    futureNodes,
    futureStart,
    futureEnd,
    futureChanges,
    currentNodes,
    currentStart,
    currentEnd,
    currentChanges,
    currentLength,
    compare,
    before
  );

  return futureNodes;
};

Object.defineProperty(exports, '__esModule', {value: true}).default = domdiff;

},{"./utils.js":26}],26:[function(require,module,exports){
'use strict';
const Map = (require('@ungap/essential-map'));

const append = (get, parent, children, start, end, before) => {
  if ((end - start) < 2)
    parent.insertBefore(get(children[start], 1), before);
  else {
    const fragment = parent.ownerDocument.createDocumentFragment();
    while (start < end)
      fragment.appendChild(get(children[start++], 1));
    parent.insertBefore(fragment, before);
  }
};
exports.append = append;

const eqeq = (a, b) => a == b;
exports.eqeq = eqeq;

const identity = O => O;
exports.identity = identity;

const indexOf = (
  moreNodes,
  moreStart,
  moreEnd,
  lessNodes,
  lessStart,
  lessEnd,
  compare
) => {
  const length = lessEnd - lessStart;
  /* istanbul ignore if */
  if (length < 1)
    return -1;
  while ((moreEnd - moreStart) >= length) {
    let m = moreStart;
    let l = lessStart;
    while (
      m < moreEnd &&
      l < lessEnd &&
      compare(moreNodes[m], lessNodes[l])
    ) {
      m++;
      l++;
    }
    if (l === lessEnd)
      return moreStart;
    moreStart = m + 1;
  }
  return -1;
};
exports.indexOf = indexOf;

const isReversed = (
  futureNodes,
  futureEnd,
  currentNodes,
  currentStart,
  currentEnd,
  compare
) => {
  while (
    currentStart < currentEnd &&
    compare(
      currentNodes[currentStart],
      futureNodes[futureEnd - 1]
    )) {
      currentStart++;
      futureEnd--;
    };
  return futureEnd === 0;
};
exports.isReversed = isReversed;

const next = (get, list, i, length, before) => i < length ?
              get(list[i], 0) :
              (0 < i ?
                get(list[i - 1], -0).nextSibling :
                before);
exports.next = next;

const remove = (get, parent, children, start, end) => {
  if ((end - start) < 2)
    parent.removeChild(get(children[start], -1));
  else {
    const range = parent.ownerDocument.createRange();
    range.setStartBefore(get(children[start], -1));
    range.setEndAfter(get(children[end - 1], -1));
    range.deleteContents();
  }
};
exports.remove = remove;

// - - - - - - - - - - - - - - - - - - -
// diff related constants and utilities
// - - - - - - - - - - - - - - - - - - -

const DELETION = -1;
const INSERTION = 1;
const SKIP = 0;
const SKIP_OND = 50;

const HS = (
  futureNodes,
  futureStart,
  futureEnd,
  futureChanges,
  currentNodes,
  currentStart,
  currentEnd,
  currentChanges
) => {

  let k = 0;
  /* istanbul ignore next */
  let minLen = futureChanges < currentChanges ? futureChanges : currentChanges;
  const link = Array(minLen++);
  const tresh = Array(minLen);
  tresh[0] = -1;

  for (let i = 1; i < minLen; i++)
    tresh[i] = currentEnd;

  const keymap = new Map;
  for (let i = currentStart; i < currentEnd; i++)
    keymap.set(currentNodes[i], i);

  for (let i = futureStart; i < futureEnd; i++) {
    const idxInOld = keymap.get(futureNodes[i]);
    if (idxInOld != null) {
      k = findK(tresh, minLen, idxInOld);
      /* istanbul ignore else */
      if (-1 < k) {
        tresh[k] = idxInOld;
        link[k] = {
          newi: i,
          oldi: idxInOld,
          prev: link[k - 1]
        };
      }
    }
  }

  k = --minLen;
  --currentEnd;
  while (tresh[k] > currentEnd) --k;

  minLen = currentChanges + futureChanges - k;
  const diff = Array(minLen);
  let ptr = link[k];
  --futureEnd;
  while (ptr) {
    const {newi, oldi} = ptr;
    while (futureEnd > newi) {
      diff[--minLen] = INSERTION;
      --futureEnd;
    }
    while (currentEnd > oldi) {
      diff[--minLen] = DELETION;
      --currentEnd;
    }
    diff[--minLen] = SKIP;
    --futureEnd;
    --currentEnd;
    ptr = ptr.prev;
  }
  while (futureEnd >= futureStart) {
    diff[--minLen] = INSERTION;
    --futureEnd;
  }
  while (currentEnd >= currentStart) {
    diff[--minLen] = DELETION;
    --currentEnd;
  }
  return diff;
};

// this is pretty much the same petit-dom code without the delete map part
// https://github.com/yelouafi/petit-dom/blob/bd6f5c919b5ae5297be01612c524c40be45f14a7/src/vdom.js#L556-L561
const OND = (
  futureNodes,
  futureStart,
  rows,
  currentNodes,
  currentStart,
  cols,
  compare
) => {
  const length = rows + cols;
  const v = [];
  let d, k, r, c, pv, cv, pd;
  outer: for (d = 0; d <= length; d++) {
    /* istanbul ignore if */
    if (d > SKIP_OND)
      return null;
    pd = d - 1;
    /* istanbul ignore next */
    pv = d ? v[d - 1] : [0, 0];
    cv = v[d] = [];
    for (k = -d; k <= d; k += 2) {
      if (k === -d || (k !== d && pv[pd + k - 1] < pv[pd + k + 1])) {
        c = pv[pd + k + 1];
      } else {
        c = pv[pd + k - 1] + 1;
      }
      r = c - k;
      while (
        c < cols &&
        r < rows &&
        compare(
          currentNodes[currentStart + c],
          futureNodes[futureStart + r]
        )
      ) {
        c++;
        r++;
      }
      if (c === cols && r === rows) {
        break outer;
      }
      cv[d + k] = c;
    }
  }

  const diff = Array(d / 2 + length / 2);
  let diffIdx = diff.length - 1;
  for (d = v.length - 1; d >= 0; d--) {
    while (
      c > 0 &&
      r > 0 &&
      compare(
        currentNodes[currentStart + c - 1],
        futureNodes[futureStart + r - 1]
      )
    ) {
      // diagonal edge = equality
      diff[diffIdx--] = SKIP;
      c--;
      r--;
    }
    if (!d)
      break;
    pd = d - 1;
    /* istanbul ignore next */
    pv = d ? v[d - 1] : [0, 0];
    k = c - r;
    if (k === -d || (k !== d && pv[pd + k - 1] < pv[pd + k + 1])) {
      // vertical edge = insertion
      r--;
      diff[diffIdx--] = INSERTION;
    } else {
      // horizontal edge = deletion
      c--;
      diff[diffIdx--] = DELETION;
    }
  }
  return diff;
};

const applyDiff = (
  diff,
  get,
  parentNode,
  futureNodes,
  futureStart,
  currentNodes,
  currentStart,
  currentLength,
  before
) => {
  const live = new Map;
  const length = diff.length;
  let currentIndex = currentStart;
  let i = 0;
  while (i < length) {
    switch (diff[i++]) {
      case SKIP:
        futureStart++;
        currentIndex++;
        break;
      case INSERTION:
        // TODO: bulk appends for sequential nodes
        live.set(futureNodes[futureStart], 1);
        append(
          get,
          parentNode,
          futureNodes,
          futureStart++,
          futureStart,
          currentIndex < currentLength ?
            get(currentNodes[currentIndex], 1) :
            before
        );
        break;
      case DELETION:
        currentIndex++;
        break;
    }
  }
  i = 0;
  while (i < length) {
    switch (diff[i++]) {
      case SKIP:
        currentStart++;
        break;
      case DELETION:
        // TODO: bulk removes for sequential nodes
        if (live.has(currentNodes[currentStart]))
          currentStart++;
        else
          remove(
            get,
            parentNode,
            currentNodes,
            currentStart++,
            currentStart
          );
        break;
    }
  }
};

const findK = (ktr, length, j) => {
  let lo = 1;
  let hi = length;
  while (lo < hi) {
    const mid = ((lo + hi) / 2) >>> 0;
    if (j < ktr[mid])
      hi = mid;
    else
      lo = mid + 1;
  }
  return lo;
}

const smartDiff = (
  get,
  parentNode,
  futureNodes,
  futureStart,
  futureEnd,
  futureChanges,
  currentNodes,
  currentStart,
  currentEnd,
  currentChanges,
  currentLength,
  compare,
  before
) => {
  applyDiff(
    OND(
      futureNodes,
      futureStart,
      futureChanges,
      currentNodes,
      currentStart,
      currentChanges,
      compare
    ) ||
    HS(
      futureNodes,
      futureStart,
      futureEnd,
      futureChanges,
      currentNodes,
      currentStart,
      currentEnd,
      currentChanges
    ),
    get,
    parentNode,
    futureNodes,
    futureStart,
    currentNodes,
    currentStart,
    currentLength,
    before
  );
};
exports.smartDiff = smartDiff;

},{"@ungap/essential-map":15}],27:[function(require,module,exports){
'use strict';
// Custom
var UID = '-' + Math.random().toFixed(6) + '%';
//                           Edge issue!
if (!(function (template, content, tabindex) {
  return content in template && (
    (template.innerHTML = '<p ' + tabindex + '="' + UID + '"></p>'),
    template[content].childNodes[0].getAttribute(tabindex) == UID
  );
}(document.createElement('template'), 'content', 'tabindex'))) {
  UID = '_dt: ' + UID.slice(1, -1) + ';';
}
var UIDC = '<!--' + UID + '-->';

// DOM
var COMMENT_NODE = 8;
var DOCUMENT_FRAGMENT_NODE = 11;
var ELEMENT_NODE = 1;
var TEXT_NODE = 3;

var SHOULD_USE_TEXT_CONTENT = /^(?:style|textarea)$/i;
var VOID_ELEMENTS = /^(?:area|base|br|col|embed|hr|img|input|keygen|link|menuitem|meta|param|source|track|wbr)$/i;

exports.UID = UID;
exports.UIDC = UIDC;
exports.COMMENT_NODE = COMMENT_NODE;
exports.DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
exports.ELEMENT_NODE = ELEMENT_NODE;
exports.TEXT_NODE = TEXT_NODE;
exports.SHOULD_USE_TEXT_CONTENT = SHOULD_USE_TEXT_CONTENT;
exports.VOID_ELEMENTS = VOID_ELEMENTS;

},{}],28:[function(require,module,exports){
'use strict';
// globals
const WeakMap = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/weakmap'));

// utils
const createContent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/create-content'));
const importNode = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/import-node'));
const trim = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/trim'));

// local
const sanitize = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./sanitizer.js'));
const {find, parse} = require('./walker.js');

// the domtagger 🎉
Object.defineProperty(exports, '__esModule', {value: true}).default = domtagger;

var parsed = new WeakMap;
var referenced = new WeakMap;

function createInfo(options, template) {
  var markup = sanitize(template);
  var transform = options.transform;
  if (transform)
    markup = transform(markup);
  var content = createContent(markup, options.type);
  cleanContent(content);
  var holes = [];
  parse(content, holes, template.slice(0), []);
  var info = {
    content: content,
    updates: function (content) {
      var callbacks = [];
      var len = holes.length;
      var i = 0;
      while (i < len) {
        var info = holes[i++];
        var node = find(content, info.path);
        switch (info.type) {
          case 'any':
            callbacks.push(options.any(node, []));
            break;
          case 'attr':
            callbacks.push(options.attribute(node, info.name, info.node));
            break;
          case 'text':
            callbacks.push(options.text(node));
            node.textContent = '';
            break;
        }
      }
      return function () {
        var length = arguments.length;
        var values = length - 1;
        var i = 1;
        if (len !== values) {
          throw new Error(
            values + ' values instead of ' + len + '\n' +
            template.join(', ')
          );
        }
        while (i < length)
          callbacks[i - 1](arguments[i++]);
        return content;
      };
    }
  };
  parsed.set(template, info);
  return info;
}

function createDetails(options, template) {
  var info = parsed.get(template) || createInfo(options, template);
  var content = importNode.call(document, info.content, true);
  var details = {
    content: content,
    template: template,
    updates: info.updates(content)
  };
  referenced.set(options, details);
  return details;
}

function domtagger(options) {
  return function (template) {
    var details = referenced.get(options);
    if (details == null || details.template !== template)
      details = createDetails(options, template);
    details.updates.apply(null, arguments);
    return details.content;
  };
}

function cleanContent(fragment) {
  var childNodes = fragment.childNodes;
  var i = childNodes.length;
  while (i--) {
    var child = childNodes[i];
    if (
      child.nodeType !== 1 &&
      trim.call(child.textContent).length === 0
    ) {
      fragment.removeChild(child);
    }
  }
}

},{"./sanitizer.js":29,"./walker.js":30,"@ungap/create-content":13,"@ungap/import-node":17,"@ungap/trim":21,"@ungap/weakmap":22}],29:[function(require,module,exports){
'use strict';
const {UID, UIDC, VOID_ELEMENTS} = require('./constants.js');

Object.defineProperty(exports, '__esModule', {value: true}).default = function (template) {
  return template.join(UIDC)
          .replace(selfClosing, fullClosing)
          .replace(attrSeeker, attrReplacer);
}

var spaces = ' \\f\\n\\r\\t';
var almostEverything = '[^ ' + spaces + '\\/>"\'=]+';
var attrName = '[ ' + spaces + ']+' + almostEverything;
var tagName = '<([A-Za-z]+[A-Za-z0-9:_-]*)((?:';
var attrPartials = '(?:\\s*=\\s*(?:\'[^\']*?\'|"[^"]*?"|<[^>]*?>|' + almostEverything + '))?)';

var attrSeeker = new RegExp(tagName + attrName + attrPartials + '+)([ ' + spaces + ']*/?>)', 'g');
var selfClosing = new RegExp(tagName + attrName + attrPartials + '*)([ ' + spaces + ']*/>)', 'g');
var findAttributes = new RegExp('(' + attrName + '\\s*=\\s*)([\'"]?)' + UIDC + '\\2', 'gi');

function attrReplacer($0, $1, $2, $3) {
  return '<' + $1 + $2.replace(findAttributes, replaceAttributes) + $3;
}

function replaceAttributes($0, $1, $2) {
  return $1 + ($2 || '"') + UID + ($2 || '"');
}

function fullClosing($0, $1, $2) {
  return VOID_ELEMENTS.test($1) ? $0 : ('<' + $1 + $2 + '></' + $1 + '>');
}

},{"./constants.js":27}],30:[function(require,module,exports){
'use strict';
const Map = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/essential-map'));
const trim = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/trim'));

const {
  UID, UIDC, COMMENT_NODE, ELEMENT_NODE, SHOULD_USE_TEXT_CONTENT, TEXT_NODE
} = require('./constants.js');

exports.find = find;
exports.parse = parse;

function create(type, node, path, name) {
  return {name: name, node: node, path: path, type: type};
}

function find(node, path) {
  var length = path.length;
  var i = 0;
  while (i < length)
    node = node.childNodes[path[i++]];
  return node;
}

function parse(node, holes, parts, path) {
  var childNodes = node.childNodes;
  var length = childNodes.length;
  var i = 0;
  while (i < length) {
    var child = childNodes[i];
    switch (child.nodeType) {
      case ELEMENT_NODE:
        var childPath = path.concat(i);
        parseAttributes(child, holes, parts, childPath);
        parse(child, holes, parts, childPath);
        break;
      case COMMENT_NODE:
        if (child.textContent === UID) {
          parts.shift();
          holes.push(
            // basicHTML or other non standard engines
            // might end up having comments in nodes
            // where they shouldn't, hence this check.
            SHOULD_USE_TEXT_CONTENT.test(node.nodeName) ?
              create('text', node, path) :
              create('any', child, path.concat(i))
          );
        }
        break;
      case TEXT_NODE:
        // the following ignore is actually covered by browsers
        // only basicHTML ends up on previous COMMENT_NODE case
        // instead of TEXT_NODE because it knows nothing about
        // special style or textarea behavior
        /* istanbul ignore if */
        if (
          SHOULD_USE_TEXT_CONTENT.test(node.nodeName) &&
          trim.call(child.textContent) === UIDC
        ) {
          parts.shift();
          holes.push(create('text', node, path));
        }
        break;
    }
    i++;
  }
}

function parseAttributes(node, holes, parts, path) {
  var cache = new Map;
  var attributes = node.attributes;
  var remove = [];
  var array = remove.slice.call(attributes, 0);
  var length = array.length;
  var i = 0;
  while (i < length) {
    var attribute = array[i++];
    if (attribute.value === UID) {
      var name = attribute.name;
      // the following ignore is covered by IE
      // and the IE9 double viewBox test
      /* istanbul ignore else */
      if (!cache.has(name)) {
        var realName = parts.shift().replace(/^(?:|[\S\s]*?\s)(\S+?)\s*=\s*['"]?$/, '$1');
        var value = attributes[realName] ||
                      // the following ignore is covered by browsers
                      // while basicHTML is already case-sensitive
                      /* istanbul ignore next */
                      attributes[realName.toLowerCase()];
        cache.set(name, value);
        holes.push(create('attr', value, path, realName));
      }
      remove.push(attribute);
    }
  }
  length = remove.length;
  i = 0;
  while (i < length) {
    // Edge HTML bug #16878726
    var attr = remove[i++];
    if (/^id$/i.test(attr.name))
      node.removeAttribute(attr.name);
    // standard browsers would work just fine here
    else
      node.removeAttributeNode(attr);
  }

  // This is a very specific Firefox/Safari issue
  // but since it should be a not so common pattern,
  // it's probably worth patching regardless.
  // Basically, scripts created through strings are death.
  // You need to create fresh new scripts instead.
  // TODO: is there any other node that needs such nonsense?
  var nodeName = node.nodeName;
  if (/^script$/i.test(nodeName)) {
    // this used to be like that
    // var script = createElement(node, nodeName);
    // then Edge arrived and decided that scripts created
    // through template documents aren't worth executing
    // so it became this ... hopefully it won't hurt in the wild
    var script = document.createElement(nodeName);
    length = attributes.length;
    i = 0;
    while (i < length)
      script.setAttributeNode(attributes[i++].cloneNode(true));
    script.textContent = node.textContent;
    node.parentNode.replaceChild(script, node);
  }
}

},{"./constants.js":27,"@ungap/essential-map":15,"@ungap/trim":21}],31:[function(require,module,exports){
'use strict';
/*! (C) 2017-2018 Andrea Giammarchi - ISC Style License */

const {Component, bind, define, hyper, wire} = require('hyperhtml');

// utils to deal with custom elements builtin extends
const ATTRIBUTE_CHANGED_CALLBACK = 'attributeChangedCallback';
const O = Object;
const classes = [];
const defineProperty = O.defineProperty;
const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
const getOwnPropertyNames = O.getOwnPropertyNames;
const getOwnPropertySymbols = O.getOwnPropertySymbols || (() => []);
const getPrototypeOf = O.getPrototypeOf || (o => o.__proto__);
const ownKeys = typeof Reflect === 'object' && Reflect.ownKeys ||
                (o => getOwnPropertyNames(o).concat(getOwnPropertySymbols(o)));
const setPrototypeOf = O.setPrototypeOf ||
                      ((o, p) => (o.__proto__ = p, o));
const camel = name => name.replace(/-([a-z])/g, ($0, $1) => $1.toUpperCase());
const {attachShadow} = HTMLElement.prototype;
const sr = new WeakMap;

class HyperHTMLElement extends HTMLElement {

  // define a custom-element in the CustomElementsRegistry
  // class MyEl extends HyperHTMLElement {}
  // MyEl.define('my-el');
  static define(name, options) {
    const Class = this;
    const proto = Class.prototype;

    const onChanged = proto[ATTRIBUTE_CHANGED_CALLBACK];
    const hasChange = !!onChanged;

    // Class.booleanAttributes
    // -----------------------------------------------
    // attributes defined as boolean will have
    // an either available or not available attribute
    // regardless of the value.
    // All falsy values, or "false", mean attribute removed
    // while truthy values will be set as is.
    // Boolean attributes are also automatically observed.
    const booleanAttributes = Class.booleanAttributes || [];
    booleanAttributes.forEach(name => {
      if (!(name in proto)) defineProperty(
        proto,
        camel(name),
        {
          configurable: true,
          get() {
            return this.hasAttribute(name);
          },
          set(value) {
            if (!value || value === 'false')
              this.removeAttribute(name);
            else
              this.setAttribute(name, value);
          }
        }
      );
    });

    // Class.observedAttributes
    // -------------------------------------------------------
    // HyperHTMLElement will directly reflect get/setAttribute
    // operation once these attributes are used, example:
    // el.observed = 123;
    // will automatically do
    // el.setAttribute('observed', 123);
    // triggering also the attributeChangedCallback
    const observedAttributes = Class.observedAttributes || [];
    observedAttributes.forEach(name => {
      // it is possible to redefine the behavior at any time
      // simply overwriting get prop() and set prop(value)
      if (!(name in proto)) defineProperty(
        proto,
        camel(name),
        {
          configurable: true,
          get() {
            return this.getAttribute(name);
          },
          set(value) {
            if (value == null)
              this.removeAttribute(name);
            else
              this.setAttribute(name, value);
          }
        }
      );
    });

    // if these are defined, overwrite the observedAttributes getter
    // to include also booleanAttributes
    const attributes = booleanAttributes.concat(observedAttributes);
    if (attributes.length)
      defineProperty(Class, 'observedAttributes', {
        get() { return attributes; }
      });

    // created() {}
    // ---------------------------------
    // an initializer method that grants
    // the node is fully known to the browser.
    // It is ensured to run either after DOMContentLoaded,
    // or once there is a next sibling (stream-friendly) so that
    // you have full access to element attributes and/or childNodes.
    const created = proto.created || function () {
      this.render();
    };

    // used to ensure create() is called once and once only
    defineProperty(
      proto,
      '_init$',
      {
        configurable: true,
        writable: true,
        value: true
      }
    );

    defineProperty(
      proto,
      ATTRIBUTE_CHANGED_CALLBACK,
      {
        configurable: true,
        value: function aCC(name, prev, curr) {
          if (this._init$) {
            checkReady.call(this, created);
            if (this._init$)
              return this._init$$.push(aCC.bind(this, name, prev, curr));
          }
          // ensure setting same value twice
          // won't trigger twice attributeChangedCallback
          if (hasChange && prev !== curr) {
            onChanged.apply(this, arguments);
          }
        }
      }
    );

    const onConnected = proto.connectedCallback;
    const hasConnect = !!onConnected;
    defineProperty(
      proto,
      'connectedCallback',
      {
        configurable: true,
        value: function cC() {
          if (this._init$) {
            checkReady.call(this, created);
            if (this._init$)
              return this._init$$.push(cC.bind(this));
          }
          if (hasConnect) {
            onConnected.apply(this, arguments);
          }
        }
      }
    );

    // define lazily all handlers
    // class { handleClick() { ... }
    // render() { `<a onclick=${this.handleClick}>` } }
    getOwnPropertyNames(proto).forEach(key => {
      if (/^handle[A-Z]/.test(key)) {
        const _key$ = '_' + key + '$';
        const method = proto[key];
        defineProperty(proto, key, {
          configurable: true,
          get() {
            return  this[_key$] ||
                    (this[_key$] = method.bind(this));
          }
        });
      }
    });

    // whenever you want to directly use the component itself
    // as EventListener, you can pass it directly.
    // https://medium.com/@WebReflection/dom-handleevent-a-cross-platform-standard-since-year-2000-5bf17287fd38
    //  class Reactive extends HyperHTMLElement {
    //    oninput(e) { console.log(this, 'changed', e.target.value); }
    //    render() { this.html`<input oninput="${this}">`; }
    //  }
    if (!('handleEvent' in proto)) {
      defineProperty(
        proto,
        'handleEvent',
        {
          configurable: true,
          value(event) {
            this[
              (event.currentTarget.dataset || {}).call ||
              ('on' + event.type)
            ](event);
          }
        }
      );
    }

    if (options && options.extends) {
      const Native = document.createElement(options.extends).constructor;
      const Intermediate = class extends Native {};
      const Super = getPrototypeOf(Class);
      ownKeys(Super)
        .filter(key => [
          'length', 'name', 'arguments', 'caller', 'prototype'
        ].indexOf(key) < 0)
        .forEach(key => defineProperty(
          Intermediate,
          key,
          getOwnPropertyDescriptor(Super, key)
        )
      );
      ownKeys(Super.prototype)
        .forEach(key => defineProperty(
          Intermediate.prototype,
          key,
          getOwnPropertyDescriptor(Super.prototype, key)
        )
      );
      setPrototypeOf(Class, Intermediate);
      setPrototypeOf(proto, Intermediate.prototype);
      customElements.define(name, Class, options);
    } else {
      customElements.define(name, Class);
    }
    classes.push(Class);
    return Class;
  }

  // weakly relate the shadowRoot for refs usage
  attachShadow() {
    const shadowRoot = attachShadow.apply(this, arguments);
    sr.set(this, shadowRoot);
    return shadowRoot;
  }

  // returns elements by ref
  get refs() {
    const value = {};
    if ('_html$' in this) {
      const all = (sr.get(this) || this).querySelectorAll('[ref]');
      for (let {length} = all, i = 0; i < length; i++) {
        const node = all[i];
        value[node.getAttribute('ref')] = node;
      }
      Object.defineProperty(this, 'refs', {value});
      return value;
    }
    return value;
  }

  // lazily bind once hyperHTML logic
  // to either the shadowRoot, if present and open,
  // the _shadowRoot property, if set due closed shadow root,
  // or the custom-element itself if no Shadow DOM is used.
  get html() {
    return this._html$ || (this.html = bind(
      // in a way or another, bind to the right node
      // backward compatible, first two could probably go already
      this.shadowRoot || this._shadowRoot || sr.get(this) || this
    ));
  }

  // it can be set too if necessary, it won't invoke render()
  set html(value) {
    defineProperty(this, '_html$', {configurable: true, value: value});
  }

  // overwrite this method with your own render
  render() {}

  // ---------------------//
  // Basic State Handling //
  // ---------------------//

  // define the default state object
  // you could use observed properties too
  get defaultState() { return {}; }

  // the state with a default
  get state() {
    return this._state$ || (this.state = this.defaultState);
  }

  // it can be set too if necessary, it won't invoke render()
  set state(value) {
    defineProperty(this, '_state$', {configurable: true, value: value});
  }

  // currently a state is a shallow copy, like in Preact or other libraries.
  // after the state is updated, the render() method will be invoked.
  // ⚠️ do not ever call this.setState() inside this.render()
  setState(state, render) {
    const target = this.state;
    const source = typeof state === 'function' ? state.call(this, target) : state;
    for (const key in source) target[key] = source[key];
    if (render !== false) this.render();
    return this;
  }

};

// exposing hyperHTML utilities
HyperHTMLElement.Component = Component;
HyperHTMLElement.bind = bind;
HyperHTMLElement.intent = define;
HyperHTMLElement.wire = wire;
HyperHTMLElement.hyper = hyper;

try {
  if (Symbol.hasInstance) classes.push(
    defineProperty(HyperHTMLElement, Symbol.hasInstance, {
      enumerable: false,
      configurable: true,
      value(instance) {
        return classes.some(isPrototypeOf, getPrototypeOf(instance));
      }
    }));
} catch(meh) {}

Object.defineProperty(exports, '__esModule', {value: true}).default = HyperHTMLElement;

// ------------------------------//
// DOMContentLoaded VS created() //
// ------------------------------//
const dom = {
  type: 'DOMContentLoaded',
  handleEvent() {
    if (dom.ready()) {
      document.removeEventListener(dom.type, dom, false);
      dom.list.splice(0).forEach(invoke);
    }
    else
      setTimeout(dom.handleEvent);
  },
  ready() {
    return document.readyState === 'complete';
  },
  list: []
};

if (!dom.ready()) {
  document.addEventListener(dom.type, dom, false);
}

function checkReady(created) {
  if (dom.ready() || isReady.call(this, created)) {
    if (this._init$) {
      const list = this._init$$;
      if (list) delete this._init$$;
      created.call(defineProperty(this, '_init$', {value: false}));
      if (list) list.forEach(invoke);
    }
  } else {
    if (!this.hasOwnProperty('_init$$'))
      defineProperty(this, '_init$$', {configurable: true, value: []});
    dom.list.push(checkReady.bind(this, created));
  }
}

function invoke(fn) {
  fn();
}

function isPrototypeOf(Class) {
  return this === Class.prototype;
}

function isReady(created) {
  let el = this;
  do { if (el.nextSibling) return true; }
  while (el = el.parentNode);
  setTimeout(checkReady.bind(this, created));
  return false;
}

},{"hyperhtml":37}],32:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var hyperStyle = (function (){'use strict';
  // from https://github.com/developit/preact/blob/33fc697ac11762a1cb6e71e9847670d047af7ce5/src/varants.js
  var IS_NON_DIMENSIONAL = /acit|ex(?:s|g|n|p|$)|rph|ows|mnc|ntw|ine[ch]|zoo|^ord/i;
  var hyphen = /([^A-Z])([A-Z]+)/g;
  return function hyperStyle(node, original) {
    return 'ownerSVGElement' in node ? svg(node, original) : update(node.style, false);
  };
  function ized($0, $1, $2) {
    return $1 + '-' + $2.toLowerCase();
  }
  function svg(node, original) {
    var style;
    if (original)
      style = original.cloneNode(true);
    else {
      node.setAttribute('style', '--hyper:style;');
      style = node.getAttributeNode('style');
    }
    style.value = '';
    node.setAttributeNode(style);
    return update(style, true);
  }
  function toStyle(object) {
    var key, css = [];
    for (key in object)
      css.push(key.replace(hyphen, ized), ':', object[key], ';');
    return css.join('');
  }
  function update(style, isSVG) {
    var oldType, oldValue;
    return function (newValue) {
      var info, key, styleValue, value;
      switch (typeof newValue) {
        case 'object':
          if (newValue) {
            if (oldType === 'object') {
              if (!isSVG) {
                if (oldValue !== newValue) {
                  for (key in oldValue) {
                    if (!(key in newValue)) {
                      style[key] = '';
                    }
                  }
                }
              }
            } else {
              if (isSVG)
                style.value = '';
              else
                style.cssText = '';
            }
            info = isSVG ? {} : style;
            for (key in newValue) {
              value = newValue[key];
              styleValue = typeof value === 'number' &&
                                  !IS_NON_DIMENSIONAL.test(key) ?
                                  (value + 'px') : value;
              if (!isSVG && /^--/.test(key))
                info.setProperty(key, styleValue);
              else
                info[key] = styleValue;
            }
            oldType = 'object';
            if (isSVG)
              style.value = toStyle((oldValue = info));
            else
              oldValue = newValue;
            break;
          }
        default:
          if (oldValue != newValue) {
            oldType = 'string';
            oldValue = newValue;
            if (isSVG)
              style.value = newValue || '';
            else
              style.cssText = newValue || '';
          }
          break;
      }
    };
  }
}());
module.exports = hyperStyle;

},{}],33:[function(require,module,exports){
/*! (c) Andrea Giammarchi - ISC */
var Wire = (function (slice, proto) {

  proto = Wire.prototype;

  proto.ELEMENT_NODE = 1;
  proto.nodeType = 111;

  proto.remove = function (keepFirst) {
    var childNodes = this.childNodes;
    var first = this.firstChild;
    var last = this.lastChild;
    this._ = null;
    if (keepFirst && childNodes.length === 2) {
      last.parentNode.removeChild(last);
    } else {
      var range = this.ownerDocument.createRange();
      range.setStartBefore(keepFirst ? childNodes[1] : first);
      range.setEndAfter(last);
      range.deleteContents();
    }
    return first;
  };

  proto.valueOf = function (forceAppend) {
    var fragment = this._;
    var noFragment = fragment == null;
    if (noFragment)
      fragment = (this._ = this.ownerDocument.createDocumentFragment());
    if (noFragment || forceAppend) {
      for (var n = this.childNodes, i = 0, l = n.length; i < l; i++)
        fragment.appendChild(n[i]);
    }
    return fragment;
  };

  return Wire;

  function Wire(childNodes) {
    var nodes = (this.childNodes = slice.call(childNodes, 0));
    this.firstChild = nodes[0];
    this.lastChild = nodes[nodes.length - 1];
    this.ownerDocument = nodes[0].ownerDocument;
    this._ = null;
  }

}([].slice));
module.exports = Wire;

},{}],34:[function(require,module,exports){
'use strict';
const CustomEvent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/custom-event'));
const Map = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/essential-map'));
const WeakMap = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/weakmap'));

// hyperHTML.Component is a very basic class
// able to create Custom Elements like components
// including the ability to listen to connect/disconnect
// events via onconnect/ondisconnect attributes
// Components can be created imperatively or declaratively.
// The main difference is that declared components
// will not automatically render on setState(...)
// to simplify state handling on render.
function Component() {
  return this; // this is needed in Edge !!!
}
Object.defineProperty(exports, '__esModule', {value: true}).default = Component

// Component is lazily setup because it needs
// wire mechanism as lazy content
function setup(content) {
  // there are various weakly referenced variables in here
  // and mostly are to use Component.for(...) static method.
  const children = new WeakMap;
  const create = Object.create;
  const createEntry = (wm, id, component) => {
    wm.set(id, component);
    return component;
  };
  const get = (Class, info, context, id) => {
    const relation = info.get(Class) || relate(Class, info);
    switch (typeof id) {
      case 'object':
      case 'function':
        const wm = relation.w || (relation.w = new WeakMap);
        return wm.get(id) || createEntry(wm, id, new Class(context));
      default:
        const sm = relation.p || (relation.p = create(null));
        return sm[id] || (sm[id] = new Class(context));
    }
  };
  const relate = (Class, info) => {
    const relation = {w: null, p: null};
    info.set(Class, relation);
    return relation;
  };
  const set = context => {
    const info = new Map;
    children.set(context, info);
    return info;
  };
  // The Component Class
  Object.defineProperties(
    Component,
    {
      // Component.for(context[, id]) is a convenient way
      // to automatically relate data/context to children components
      // If not created yet, the new Component(context) is weakly stored
      // and after that same instance would always be returned.
      for: {
        configurable: true,
        value(context, id) {
          return get(
            this,
            children.get(context) || set(context),
            context,
            id == null ?
              'default' : id
          );
        }
      }
    }
  );
  Object.defineProperties(
    Component.prototype,
    {
      // all events are handled with the component as context
      handleEvent: {value(e) {
        const ct = e.currentTarget;
        this[
          ('getAttribute' in ct && ct.getAttribute('data-call')) ||
          ('on' + e.type)
        ](e);
      }},
      // components will lazily define html or svg properties
      // as soon as these are invoked within the .render() method
      // Such render() method is not provided by the base class
      // but it must be available through the Component extend.
      // Declared components could implement a
      // render(props) method too and use props as needed.
      html: lazyGetter('html', content),
      svg: lazyGetter('svg', content),
      // the state is a very basic/simple mechanism inspired by Preact
      state: lazyGetter('state', function () { return this.defaultState; }),
      // it is possible to define a default state that'd be always an object otherwise
      defaultState: {get() { return {}; }},
      // dispatch a bubbling, cancelable, custom event
      // through the first known/available node
      dispatch: {value(type, detail) {
        const {_wire$} = this;
        if (_wire$) {
          const event = new CustomEvent(type, {
            bubbles: true,
            cancelable: true,
            detail
          });
          event.component = this;
          return (_wire$.dispatchEvent ?
                    _wire$ :
                    _wire$.firstChild
                  ).dispatchEvent(event);
        }
        return false;
      }},
      // setting some property state through a new object
      // or a callback, triggers also automatically a render
      // unless explicitly specified to not do so (render === false)
      setState: {value(state, render) {
        const target = this.state;
        const source = typeof state === 'function' ? state.call(this, target) : state;
        for (const key in source) target[key] = source[key];
        if (render !== false)
          this.render();
        return this;
      }}
    }
  );
}
exports.setup = setup

// instead of a secret key I could've used a WeakMap
// However, attaching a property directly will result
// into better performance with thousands of components
// hanging around, and less memory pressure caused by the WeakMap
const lazyGetter = (type, fn) => {
  const secret = '_' + type + '$';
  return {
    get() {
      return this[secret] || setValue(this, secret, fn.call(this, type));
    },
    set(value) {
      setValue(this, secret, value);
    }
  };
};

// shortcut to set value on get or set(value)
const setValue = (self, secret, value) =>
  Object.defineProperty(self, secret, {
    configurable: true,
    value: typeof value === 'function' ?
      function () {
        return (self._wire$ = value.apply(this, arguments));
      } :
      value
  })[secret]
;

Object.defineProperties(
  Component.prototype,
  {
    // used to distinguish better than instanceof
    ELEMENT_NODE: {value: 1},
    nodeType: {value: -1}
  }
);

},{"@ungap/custom-event":14,"@ungap/essential-map":15,"@ungap/weakmap":22}],35:[function(require,module,exports){
'use strict';
const WeakMap = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/weakmap'));
const tta = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/template-tag-arguments'));

const {OWNER_SVG_ELEMENT} = require('../shared/constants.js');
const {Tagger} = require('../objects/Updates.js');

// a weak collection of contexts that
// are already known to hyperHTML
const bewitched = new WeakMap;

// better known as hyper.bind(node), the render is
// the main tag function in charge of fully upgrading
// or simply updating, contexts used as hyperHTML targets.
// The `this` context is either a regular DOM node or a fragment.
function render() {
  const wicked = bewitched.get(this);
  const args = tta.apply(null, arguments);
  if (wicked && wicked.template === args[0]) {
    wicked.tagger.apply(null, args);
  } else {
    upgrade.apply(this, args);
  }
  return this;
}

// an upgrade is in charge of collecting template info,
// parse it once, if unknown, to map all interpolations
// as single DOM callbacks, relate such template
// to the current context, and render it after cleaning the context up
function upgrade(template) {
  const type = OWNER_SVG_ELEMENT in this ? 'svg' : 'html';
  const tagger = new Tagger(type);
  bewitched.set(this, {tagger, template: template});
  this.textContent = '';
  this.appendChild(tagger.apply(null, arguments));
}

Object.defineProperty(exports, '__esModule', {value: true}).default = render;

},{"../objects/Updates.js":39,"../shared/constants.js":40,"@ungap/template-tag-arguments":20,"@ungap/weakmap":22}],36:[function(require,module,exports){
'use strict';
const WeakMap = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/weakmap'));
const tta = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/template-tag-arguments'));

const Wire = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('hyperhtml-wire'));

const {Tagger} = require('../objects/Updates.js');

// all wires used per each context
const wires = new WeakMap;

// A wire is a callback used as tag function
// to lazily relate a generic object to a template literal.
// hyper.wire(user)`<div id=user>${user.name}</div>`; => the div#user
// This provides the ability to have a unique DOM structure
// related to a unique JS object through a reusable template literal.
// A wire can specify a type, as svg or html, and also an id
// via html:id or :id convention. Such :id allows same JS objects
// to be associated to different DOM structures accordingly with
// the used template literal without losing previously rendered parts.
const wire = (obj, type) => obj == null ?
  content(type || 'html') :
  weakly(obj, type || 'html');

// A wire content is a virtual reference to one or more nodes.
// It's represented by either a DOM node, or an Array.
// In both cases, the wire content role is to simply update
// all nodes through the list of related callbacks.
// In few words, a wire content is like an invisible parent node
// in charge of updating its content like a bound element would do.
const content = type => {
  let wire, tagger, template;
  return function () {
    const args = tta.apply(null, arguments);
    if (template !== args[0]) {
      template = args[0];
      tagger = new Tagger(type);
      wire = wireContent(tagger.apply(tagger, args));
    } else {
      tagger.apply(tagger, args);
    }
    return wire;
  };
};

// wires are weakly created through objects.
// Each object can have multiple wires associated
// and this is thanks to the type + :id feature.
const weakly = (obj, type) => {
  const i = type.indexOf(':');
  let wire = wires.get(obj);
  let id = type;
  if (-1 < i) {
    id = type.slice(i + 1);
    type = type.slice(0, i) || 'html';
  }
  if (!wire)
    wires.set(obj, wire = {});
  return wire[id] || (wire[id] = content(type));
};

// A document fragment loses its nodes 
// as soon as it is appended into another node.
// This has the undesired effect of losing wired content
// on a second render call, because (by then) the fragment would be empty:
// no longer providing access to those sub-nodes that ultimately need to
// stay associated with the original interpolation.
// To prevent hyperHTML from forgetting about a fragment's sub-nodes,
// fragments are instead returned as an Array of nodes or, if there's only one entry,
// as a single referenced node which, unlike fragments, will indeed persist
// wire content throughout multiple renderings.
// The initial fragment, at this point, would be used as unique reference to this
// array of nodes or to this single referenced node.
const wireContent = node => {
  const childNodes = node.childNodes;
  const {length} = childNodes;
  return length === 1 ?
    childNodes[0] :
    (length ? new Wire(childNodes) : node);
};

exports.content = content;
exports.weakly = weakly;
Object.defineProperty(exports, '__esModule', {value: true}).default = wire;

},{"../objects/Updates.js":39,"@ungap/template-tag-arguments":20,"@ungap/weakmap":22,"hyperhtml-wire":33}],37:[function(require,module,exports){
'use strict';
/*! (c) Andrea Giammarchi (ISC) */
const WeakMap = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/weakmap'));
const WeakSet = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/essential-weakset'));

const diff = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('domdiff'));
const Component = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./classes/Component.js'));
const {setup} = require('./classes/Component.js');
const Intent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./objects/Intent.js'));
const {observe, Tagger} = require('./objects/Updates.js');
const wire = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./hyper/wire.js'));
const {content, weakly} = require('./hyper/wire.js');
const render = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./hyper/render.js'));

// all functions are self bound to the right context
// you can do the following
// const {bind, wire} = hyperHTML;
// and use them right away: bind(node)`hello!`;
const bind = context => render.bind(context);
const define = Intent.define;
const tagger = Tagger.prototype;

hyper.Component = Component;
hyper.bind = bind;
hyper.define = define;
hyper.diff = diff;
hyper.hyper = hyper;
hyper.observe = observe;
hyper.tagger = tagger;
hyper.wire = wire;

// exported as shared utils
// for projects based on hyperHTML
// that don't necessarily need upfront polyfills
// i.e. those still targeting IE
hyper._ = {
  WeakMap,
  WeakSet
};

// the wire content is the lazy defined
// html or svg property of each hyper.Component
setup(content);

// everything is exported directly or through the
// hyperHTML callback, when used as top level script
exports.Component = Component;
exports.bind = bind;
exports.define = define;
exports.diff = diff;
exports.hyper = hyper;
exports.observe = observe;
exports.tagger = tagger;
exports.wire = wire;

// by default, hyperHTML is a smart function
// that "magically" understands what's the best
// thing to do with passed arguments
function hyper(HTML) {
  return arguments.length < 2 ?
    (HTML == null ?
      content('html') :
      (typeof HTML === 'string' ?
        hyper.wire(null, HTML) :
        ('raw' in HTML ?
          content('html')(HTML) :
          ('nodeType' in HTML ?
            hyper.bind(HTML) :
            weakly(HTML, 'html')
          )
        )
      )) :
    ('raw' in HTML ?
      content('html') : hyper.wire
    ).apply(null, arguments);
}
Object.defineProperty(exports, '__esModule', {value: true}).default = hyper

},{"./classes/Component.js":34,"./hyper/render.js":35,"./hyper/wire.js":36,"./objects/Intent.js":38,"./objects/Updates.js":39,"@ungap/essential-weakset":16,"@ungap/weakmap":22,"domdiff":25}],38:[function(require,module,exports){
'use strict';
const attributes = {};
const intents = {};
const keys = [];
const hasOwnProperty = intents.hasOwnProperty;

let length = 0;

Object.defineProperty(exports, '__esModule', {value: true}).default = {

  // used to invoke right away hyper:attributes
  attributes,

  // hyperHTML.define('intent', (object, update) => {...})
  // can be used to define a third parts update mechanism
  // when every other known mechanism failed.
  // hyper.define('user', info => info.name);
  // hyper(node)`<p>${{user}}</p>`;
  define: (intent, callback) => {
    if (intent.indexOf('-') < 0) {
      if (!(intent in intents)) {
        length = keys.push(intent);
      }
      intents[intent] = callback;
    } else {
      attributes[intent] = callback;
    }
  },

  // this method is used internally as last resort
  // to retrieve a value out of an object
  invoke: (object, callback) => {
    for (let i = 0; i < length; i++) {
      let key = keys[i];
      if (hasOwnProperty.call(object, key)) {
        return intents[key](object[key], callback);
      }
    }
  }
};

},{}],39:[function(require,module,exports){
'use strict';
const CustomEvent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/custom-event'));
const WeakSet = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/essential-weakset'));
const isArray = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/is-array'));
const createContent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('@ungap/create-content'));

const disconnected = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('disconnected'));
const domdiff = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('domdiff'));
const domtagger = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('domtagger'));
const hyperStyle = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('hyperhtml-style'));
const Wire = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('hyperhtml-wire'));

const {
  CONNECTED, DISCONNECTED, DOCUMENT_FRAGMENT_NODE, OWNER_SVG_ELEMENT
} = require('../shared/constants.js');

const Component = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('../classes/Component.js'));
const Intent = (m => m.__esModule ? /* istanbul ignore next */ m.default : /* istanbul ignore next */ m)(require('./Intent.js'));

const componentType = Component.prototype.nodeType;
const wireType = Wire.prototype.nodeType;

const observe = disconnected({Event: CustomEvent, WeakSet});

exports.Tagger = Tagger;
exports.observe = observe;

// returns an intent to explicitly inject content as html
const asHTML = html => ({html});

// returns nodes from wires and components
const asNode = (item, i) => {
  switch (item.nodeType) {
    case wireType:
      // in the Wire case, the content can be
      // removed, post-pended, inserted, or pre-pended and
      // all these cases are handled by domdiff already
      /* istanbul ignore next */
      return (1 / i) < 0 ?
        (i ? item.remove(true) : item.lastChild) :
        (i ? item.valueOf(true) : item.firstChild);
    case componentType:
      return asNode(item.render(), i);
    default:
      return item;
  }
}

// returns true if domdiff can handle the value
const canDiff = value => 'ELEMENT_NODE' in value;

// when a Promise is used as interpolation value
// its result must be parsed once resolved.
// This callback is in charge of understanding what to do
// with a returned value once the promise is resolved.
const invokeAtDistance = (value, callback) => {
  callback(value.placeholder);
  if ('text' in value) {
    Promise.resolve(value.text).then(String).then(callback);
  } else if ('any' in value) {
    Promise.resolve(value.any).then(callback);
  } else if ('html' in value) {
    Promise.resolve(value.html).then(asHTML).then(callback);
  } else {
    Promise.resolve(Intent.invoke(value, callback)).then(callback);
  }
};

// quick and dirty way to check for Promise/ish values
const isPromise_ish = value => value != null && 'then' in value;

// list of attributes that should not be directly assigned
const readOnly = /^(?:form|list)$/i;

// reused every slice time
const slice = [].slice;

// simplifies text node creation
const text = (node, text) => node.ownerDocument.createTextNode(text);

function Tagger(type) {
  this.type = type;
  return domtagger(this);
}

Tagger.prototype = {

  // there are four kind of attributes, and related behavior:
  //  * events, with a name starting with `on`, to add/remove event listeners
  //  * special, with a name present in their inherited prototype, accessed directly
  //  * regular, accessed through get/setAttribute standard DOM methods
  //  * style, the only regular attribute that also accepts an object as value
  //    so that you can style=${{width: 120}}. In this case, the behavior has been
  //    fully inspired by Preact library and its simplicity.
  attribute(node, name, original) {
    const isSVG = OWNER_SVG_ELEMENT in node;
    let oldValue;
    // if the attribute is the style one
    // handle it differently from others
    if (name === 'style')
      return hyperStyle(node, original, isSVG);
    // the name is an event one,
    // add/remove event listeners accordingly
    else if (/^on/.test(name)) {
      let type = name.slice(2);
      if (type === CONNECTED || type === DISCONNECTED) {
        observe(node);
      }
      else if (name.toLowerCase()
        in node) {
        type = type.toLowerCase();
      }
      return newValue => {
        if (oldValue !== newValue) {
          if (oldValue)
            node.removeEventListener(type, oldValue, false);
          oldValue = newValue;
          if (newValue)
            node.addEventListener(type, newValue, false);
        }
      };
    }
    // the attribute is special ('value' in input)
    // and it's not SVG *or* the name is exactly data,
    // in this case assign the value directly
    else if (
      name === 'data' ||
      (!isSVG && name in node && !readOnly.test(name))
    ) {
      return newValue => {
        if (oldValue !== newValue) {
          oldValue = newValue;
          if (node[name] !== newValue) {
            node[name] = newValue;
            if (newValue == null) {
              node.removeAttribute(name);
            }
          }
        }
      };
    }
    else if (name in Intent.attributes) {
      oldValue;
      return any => {
        const newValue = Intent.attributes[name](node, any);
        if (oldValue !== newValue) {
          oldValue = newValue;
          if (newValue == null)
            node.removeAttribute(name);
          else
            node.setAttribute(name, newValue);
        }
      };
    }
    // in every other case, use the attribute node as it is
    // update only the value, set it as node only when/if needed
    else {
      let owner = false;
      const attribute = original.cloneNode(true);
      return newValue => {
        if (oldValue !== newValue) {
          oldValue = newValue;
          if (attribute.value !== newValue) {
            if (newValue == null) {
              if (owner) {
                owner = false;
                node.removeAttributeNode(attribute);
              }
              attribute.value = newValue;
            } else {
              attribute.value = newValue;
              if (!owner) {
                owner = true;
                node.setAttributeNode(attribute);
              }
            }
          }
        }
      };
    }
  },

  // in a hyper(node)`<div>${content}</div>` case
  // everything could happen:
  //  * it's a JS primitive, stored as text
  //  * it's null or undefined, the node should be cleaned
  //  * it's a component, update the content by rendering it
  //  * it's a promise, update the content once resolved
  //  * it's an explicit intent, perform the desired operation
  //  * it's an Array, resolve all values if Promises and/or
  //    update the node with the resulting list of content
  any(node, childNodes) {
    const diffOptions = {node: asNode, before: node};
    const nodeType = OWNER_SVG_ELEMENT in node ? /* istanbul ignore next */ 'svg' : 'html';
    let fastPath = false;
    let oldValue;
    const anyContent = value => {
      switch (typeof value) {
        case 'string':
        case 'number':
        case 'boolean':
          if (fastPath) {
            if (oldValue !== value) {
              oldValue = value;
              childNodes[0].textContent = value;
            }
          } else {
            fastPath = true;
            oldValue = value;
            childNodes = domdiff(
              node.parentNode,
              childNodes,
              [text(node, value)],
              diffOptions
            );
          }
          break;
        case 'function':
          anyContent(value(node));
          break;
        case 'object':
        case 'undefined':
          if (value == null) {
            fastPath = false;
            childNodes = domdiff(
              node.parentNode,
              childNodes,
              [],
              diffOptions
            );
            break;
          }
        default:
          fastPath = false;
          oldValue = value;
          if (isArray(value)) {
            if (value.length === 0) {
              if (childNodes.length) {
                childNodes = domdiff(
                  node.parentNode,
                  childNodes,
                  [],
                  diffOptions
                );
              }
            } else {
              switch (typeof value[0]) {
                case 'string':
                case 'number':
                case 'boolean':
                  anyContent({html: value});
                  break;
                case 'object':
                  if (isArray(value[0])) {
                    value = value.concat.apply([], value);
                  }
                  if (isPromise_ish(value[0])) {
                    Promise.all(value).then(anyContent);
                    break;
                  }
                default:
                  childNodes = domdiff(
                    node.parentNode,
                    childNodes,
                    value,
                    diffOptions
                  );
                  break;
              }
            }
          } else if (canDiff(value)) {
            childNodes = domdiff(
              node.parentNode,
              childNodes,
              value.nodeType === DOCUMENT_FRAGMENT_NODE ?
                slice.call(value.childNodes) :
                [value],
              diffOptions
            );
          } else if (isPromise_ish(value)) {
            value.then(anyContent);
          } else if ('placeholder' in value) {
            invokeAtDistance(value, anyContent);
          } else if ('text' in value) {
            anyContent(String(value.text));
          } else if ('any' in value) {
            anyContent(value.any);
          } else if ('html' in value) {
            childNodes = domdiff(
              node.parentNode,
              childNodes,
              slice.call(
                createContent(
                  [].concat(value.html).join(''),
                  nodeType
                ).childNodes
              ),
              diffOptions
            );
          } else if ('length' in value) {
            anyContent(slice.call(value));
          } else {
            anyContent(Intent.invoke(value, anyContent));
          }
          break;
      }
    };
    return anyContent;
  },

  // style or textareas don't accept HTML as content
  // it's pointless to transform or analyze anything
  // different from text there but it's worth checking
  // for possible defined intents.
  text(node) {
    let oldValue;
    const textContent = value => {
      if (oldValue !== value) {
        oldValue = value;
        const type = typeof value;
        if (type === 'object' && value) {
          if (isPromise_ish(value)) {
            value.then(textContent);
          } else if ('placeholder' in value) {
            invokeAtDistance(value, textContent);
          } else if ('text' in value) {
            textContent(String(value.text));
          } else if ('any' in value) {
            textContent(value.any);
          } else if ('html' in value) {
            textContent([].concat(value.html).join(''));
          } else if ('length' in value) {
            textContent(slice.call(value).join(''));
          } else {
            textContent(Intent.invoke(value, textContent));
          }
        } else if (type === 'function') {
          textContent(value(node));
        } else {
          node.textContent = value == null ? '' : value;
        }
      }
    };
    return textContent;
  }
};

},{"../classes/Component.js":34,"../shared/constants.js":40,"./Intent.js":38,"@ungap/create-content":13,"@ungap/custom-event":14,"@ungap/essential-weakset":16,"@ungap/is-array":18,"disconnected":23,"domdiff":25,"domtagger":28,"hyperhtml-style":32,"hyperhtml-wire":33}],40:[function(require,module,exports){
'use strict';
// Node.CONSTANTS
// 'cause some engine has no global Node defined
// (i.e. Node, NativeScript, basicHTML ... )
const ELEMENT_NODE = 1;
exports.ELEMENT_NODE = ELEMENT_NODE;
const DOCUMENT_FRAGMENT_NODE = 11;
exports.DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;

// SVG related constants
const OWNER_SVG_ELEMENT = 'ownerSVGElement';
exports.OWNER_SVG_ELEMENT = OWNER_SVG_ELEMENT;

// Custom Elements / MutationObserver constants
const CONNECTED = 'connected';
exports.CONNECTED = CONNECTED;
const DISCONNECTED = 'dis' + CONNECTED;
exports.DISCONNECTED = DISCONNECTED;

},{}]},{},[2]);
