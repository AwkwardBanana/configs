'use strict';

/* For ESLint: List any global identifiers used in this file below */
/* global chrome, backgroundPage, optionalSettings, Subscription, filterStorage, filterNotifier,
   syncErrorCode, parseFilter, translate, checkForSyncError, isSelectorFilter */

let originalCustomFilters;

function cleanCustomFilter(filters) {
  // Remove the global pause white-list item if adblock is paused
  if (backgroundPage.adblockIsPaused()) {
    let index = filters.indexOf(backgroundPage.pausedFilterText1);
    if (index >= 0) {
      filters.splice(index, 1);
    }
    index = filters.indexOf(backgroundPage.pausedFilterText2);
    if (index >= 0) {
      filters.splice(index, 1);
    }
  }

  // Remove the domain pause white-list items
  const domainPauses = backgroundPage.adblockIsDomainPaused();
  for (const aDomain in domainPauses) {
    const index = filters.indexOf(`@@${aDomain}$document`);
    if (index >= 0) {
      filters.splice(index, 1);
    }
  }

  return filters;
}

function onFilterChange() {
  if (syncErrorCode >= 400) {
    // disable all the buttons on the page
    // refreshing the page will re-enable the buttons, etc.
    $('.accordion-icon .material-icons').css('color', 'grey');
    $('button').removeClass('red').css('background-color', 'grey');
    const newStyle = document.createElement('style');
    newStyle.type = 'text/css';
    newStyle.appendChild(document.createTextNode(''));
    document.head.appendChild(newStyle);
    newStyle.sheet.insertRule('.btn:hover { font-weight: normal !important; cursor: unset !important; box-shadow: none !important; }', 0);
    return;
  }
  const userFilters = backgroundPage.getUserFilters();
  if (userFilters
    && userFilters.length) {
    originalCustomFilters = cleanCustomFilter(userFilters);
    $('#txtFiltersAdvanced').val(originalCustomFilters.join('\n'));
  } else {
    $('#txtFiltersAdvanced').val('');
  }
}

$(() => {
  $('#tutorlink').attr('href', backgroundPage.Utils.getDocLink('filterdoc'));

  const getExcludeFilters = function () {
    const excludeFiltersKey = 'exclude_filters';
    chrome.storage.local.get(excludeFiltersKey).then((response) => {
      if (response[excludeFiltersKey]) {
        $('#txtExcludeFiltersAdvanced').val(response[excludeFiltersKey]);
        $('#divExcludeFilters').show();
      }
    });
  };
  getExcludeFilters();

  // Display any migration error messages to the user
  chrome.storage.local.get('custom_filters_errors').then((response) => {
    if (response.custom_filters_errors) {
      $('#txtMigrationErrorMessage').val(response.custom_filters_errors);
      $('#migrationErrorMessageDiv').show();
      $('#btnDeleteMigrationErrorMessage').click(() => {
        chrome.storage.local.remove('custom_filters_errors');
        $('#migrationErrorMessageDiv').hide();
      });
    }
  });

  // Update custom filter count in the background.
  // Inputs: customFiltersText:string - string representation of the custom filters
  // delimited by new line.
  function updateCustomFiltersCount(customFiltersText) {
    const customFiltersArray = customFiltersText.split('\n');
    const newCount = {};
    const tempFilterTracker = [];
    for (let i = 0; i < customFiltersArray.length; i++) {
      const filter = customFiltersArray[i];

      // Check if filter is a duplicate and that it is a hiding filter.
      if (tempFilterTracker.indexOf(filter) < 0 && filter.indexOf('##') > -1) {
        tempFilterTracker.push(filter);
        const host = filter.split('##')[0];
        newCount[host] = (newCount[host] || 0) + 1;
      }
    }

    backgroundPage.updateCustomFilterCountMap(newCount);
  }

  function saveFilters() {
    const customFiltersText = $('#txtFiltersAdvanced').val();
    const customFiltersArray = customFiltersText.split('\n');
    let filterErrorMessage = '';
    $('#messagecustom').html(filterErrorMessage);
    for (let i = 0; (!filterErrorMessage && i < customFiltersArray.length); i++) {
      let filter = customFiltersArray[i];
      filter = filter.trim();
      if (filter.length > 0) {
        const result = parseFilter(filter);
        if (result.error) {
          filterErrorMessage = translate(
            'customfilterserrormessage',
            [result.filter.text, result.error],
          );
        }
      }
    }

    if (filterErrorMessage) {
      $('#messagecustom').html(filterErrorMessage);
      $('#messagecustom').removeClass('do-not-display');
    } else {
      if (backgroundPage.adblockIsPaused()) {
        customFiltersArray.push('@@');
        customFiltersArray.push('@@^$document');
      }
      for (let i = 0; (i < customFiltersArray.length); i++) {
        let filter = customFiltersArray[i];
        filter = filter.trim();
        if (filter.length > 0) {
          const result = parseFilter(filter);
          if (result.filter) {
            filterStorage.addFilter(result.filter);
          }
        }
      }

      // Delete / remove filters the user removed...
      if (originalCustomFilters) {
        for (let i = 0; (i < originalCustomFilters.length); i++) {
          let filter = originalCustomFilters[i];
          if (customFiltersArray.indexOf(filter) === -1) {
            filter = filter.trim();
            if (filter.length > 0) {
              const result = parseFilter(filter);
              if (result.filter) {
                filterStorage.removeFilter(result.filter);
              }
            }
          }
        }
      }

      originalCustomFilters = customFiltersArray;
      updateCustomFiltersCount(customFiltersText);
      $('#divAddNewFilter').slideDown();
      $('#txtFiltersAdvanced').prop('disabled', true);
      $('#spanSaveButton').hide();
      $('#btnEditAdvancedFilters').show();
    }
  }

  // Add a custom filter to the list
  function appendCustomFilter(filter) {
    const $customFilter = $('#txtFiltersAdvanced');
    $customFilter.val(`${filter}\n${$('#txtFiltersAdvanced').val()}`);
    saveFilters();
    $('.addControls').slideUp();
  }

  // Convert a messy list of domains to ~domain1.com|~domain2.com format
  function toTildePipeFormat(inputDomainList) {
    let domainList = inputDomainList.trim().replace(/[ ,;|]+~?/g, '|~');
    if (domainList && domainList[0] !== '~') {
      domainList = `~${domainList}`;
    }

    return domainList;
  }

  $('#txtBlacklist').focus(function BlacklistTextFocused() {
    // Find the blacklist entry in the user's filters, and put it
    // into the blacklist input.
    const customFilterText = $('#txtFiltersAdvanced').val();
    const match = customFilterText.match(/^@@\*\$document,domain=(~.*)$/m);
    if (match && $(this).val() === '') {
      $(this).val(match[1]);
    }
  });

  // The add_filter functions
  $('#btnAddUserFilter').click(checkForSyncError((event) => {
    const blockCss = $('#txtUserFilterCss').val().trim();
    const blockDomain = $('#txtUserFilterDomain').val().trim();

    if (blockDomain === '.*' || blockDomain === '*' || blockDomain === '') {
      appendCustomFilter(`##${blockCss}`);
    } else {
      appendCustomFilter(`${blockDomain}##${blockCss}`);
    }

    $(event.target).closest('.customize-entry-table').find('input[type=\'text\']').val('');
    $(event.target).prop('disabled', true);
  }));

  $('#btnAddExcludeFilter').click(checkForSyncError((event) => {
    let excludeUrl = $('#txtUnblock').val().trim();

    // prevent regexes
    if (/^\/.*\/$/.test(excludeUrl)) {
      excludeUrl += '*';
    }

    appendCustomFilter(`@@${excludeUrl}$document`);

    $(event.target).closest('.customize-entry-table').find('input[type=\'text\']').val('');
    $(event.target).prop('disabled', true);
  }));

  $('#btnAddBlacklist').click(checkForSyncError(() => {
    const blacklist = toTildePipeFormat($('#txtBlacklist').val());

    let filters = `${$('#txtFiltersAdvanced').val().trim()}\n`;

    // Delete the first likely line
    filters = filters.replace(/^@@\*\$document,domain=~.*\n/m, '').trim();
    $('#txtFiltersAdvanced').val(filters);

    // Add our line in its place, or if it was empty, remove the filter
    if (blacklist) {
      appendCustomFilter(`@@*$document,domain=${blacklist}`);
    } else {
      saveFilters();
    } // just record the deletion

    $('#btnAddBlacklist').prop('disabled', true);
  }));

  $('#btnAddUrlBlock').click(checkForSyncError((event) => {
    let blockUrl = $('#txtBlockUrl').val().trim();
    let blockDomain = $('#txtBlockUrlDomain').val().trim();
    if (blockDomain === '*') {
      blockDomain = '';
    }

    // prevent regexes
    if (/^\/.*\/$/.test(blockUrl)) {
      blockUrl += '*';
    }

    if (blockDomain === '') {
      appendCustomFilter(blockUrl);
    } else {
      appendCustomFilter(`${blockUrl}$domain=${blockDomain}`);
    }

    $(event.target).closest('.customize-entry-table').find('input[type=\'text\']').val('');
    $(event.target).prop('disabled', true);
  }));

  // The validation functions
  $('#txtBlacklist').bind('input', checkForSyncError(() => {
    let blacklist = toTildePipeFormat($('#txtBlacklist').val());

    if (blacklist) {
      blacklist = `@@*$document,domain=${blacklist}`;
    }

    let filterErrorMessage = '';
    $('#messageBlacklist').text(filterErrorMessage);
    $('#messageBlacklist').hide();
    const result = parseFilter(blacklist);

    if (result.error) {
      $('#btnAddBlacklist').prop('disabled', true);
      filterErrorMessage = translate('customfilterserrormessage', [$('#txtBlacklist').val(), result.error]);
      $('#messageBlacklist').text(filterErrorMessage);
      $('#messageBlacklist').show();
      return;
    }

    $('#btnAddBlacklist').prop('disabled', false);
  }));

  $('#divUrlBlock input[type=\'text\']').bind('input', checkForSyncError(() => {
    const blockUrl = $('#txtBlockUrl').val().trim();
    let blockDomain = $('#txtBlockUrlDomain').val().trim();
    if (blockDomain === '*') {
      blockDomain = '';
    }

    if (blockDomain) {
      blockDomain = `$domain=${blockDomain}`;
    }

    const result = parseFilter(blockUrl + blockDomain);
    $('#btnAddUrlBlock').prop('disabled', (result.error) ? true : null);
  }));

  $('#divCssBlock input[type=\'text\']').bind('input', checkForSyncError(() => {
    const blockCss = $('#txtUserFilterCss').val().trim();
    let blockDomain = $('#txtUserFilterDomain').val().trim();
    if (blockDomain === '*') {
      blockDomain = '';
    }

    const result = parseFilter(`${blockDomain}##${blockCss}`);
    $('#btnAddUserFilter').prop('disabled', (result.error) ? true : null);
  }));

  $('#divExcludeBlock input[type=\'text\']').bind('input', checkForSyncError(() => {
    const unblockUrl = $('#txtUnblock').val().trim();
    const result = parseFilter(`@@${unblockUrl}$document`);
    if (!unblockUrl || isSelectorFilter(unblockUrl)) {
      result.error = true;
    }

    $('#btnAddExcludeFilter').prop('disabled', (result.error) ? true : null);
  }));

  // When one presses 'Enter', pretend it was a click on the 'add' button
  $('.customize-entry-table input[type=\'text\']').keypress(checkForSyncError((event) => {
    const submitButton = $(event.target).closest('.customize-entry-table').find('input[type=\'button\']');
    if (event.keyCode === 13 && !submitButton.prop('disabled')) {
      event.preventDefault();
      submitButton.click();
    }
  }));

  $('a.controlsLink').click(checkForSyncError((event) => {
    event.preventDefault();
    const $myControls = $(event.target).parent('div').find('.addControls');
    $('.addControls').not($myControls).slideUp({
      complete() {
        $(event.target).parent('div').find('.accordion-icon').removeClass('upward');
      },
    });
    $myControls.slideToggle({
      complete() {
        const $icon = $(event.target).parent('div').find('.accordion-icon');
        const isExpanded = $(event.target).css('display') !== 'none';

        if (isExpanded) {
          $icon.addClass('upward');
        } else {
          $icon.removeClass('upward');
        }
      },
    });
  }));

  $('#btnEditAdvancedFilters').click(checkForSyncError((event) => {
    const headerOffset = $('#header').height() + 10;
    $('body, html').animate({
      scrollTop: $(event.target).offset().top - headerOffset,
    }, 1000);
    $('#txtFiltersAdvanced').prop('disabled', false);
    $('#spanSaveButton').show();
    $('#btnEditAdvancedFilters').hide();
    $('#txtFiltersAdvanced').focus();
  }));


  $('#btnEditExcludeAdvancedFilters').click(checkForSyncError((event) => {
    const headerOffset = $('#header').height() + 10;
    $('body, html').animate({
      scrollTop: $(event.target).offset().top - headerOffset,
    }, 1000);
    $('#txtExcludeFiltersAdvanced').removeAttr('disabled');
    $('#spanSaveExcludeButton').show();
    $('#btnEditExcludeAdvancedFilters').hide();
    $('#txtExcludeFiltersAdvanced').focus();
  }));

  $('#btnSaveAdvancedFilters').click(saveFilters);

  $('#btnSaveExcludeAdvancedFilters').click(checkForSyncError(() => {
    const excludeFiltersText = $('#txtExcludeFiltersAdvanced').val();
    backgroundPage.ExcludeFilter.setExcludeFilters(excludeFiltersText);
    $('#divAddNewFilter').slideDown();
    $('#txtExcludeFiltersAdvanced').attr('disabled', 'disabled');
    $('#spanSaveExcludeButton').hide();
    $('#btnEditExcludeAdvancedFilters').show();
    getExcludeFilters();
  }));

  const userFilters = backgroundPage.getUserFilters();
  if (userFilters && userFilters.length) {
    originalCustomFilters = cleanCustomFilter(userFilters);
    $('#txtFiltersAdvanced').val(originalCustomFilters.join('\n'));
  }

  if (optionalSettings && optionalSettings.show_advanced_options) {
    $('#divExcludeFilters').show();
  }

  filterNotifier.on('save', onFilterChange);
  window.addEventListener('unload', () => {
    filterNotifier.off('save', onFilterChange);
  });
});
