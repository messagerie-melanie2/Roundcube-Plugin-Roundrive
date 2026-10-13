/**
 * Kolab files plugin
 *
 * @author Aleksander Machniak <machniak@kolabsys.com>
 *
 * @licstart  The following is the entire license notice for the
 * JavaScript code in this file.
 *
 * Copyright (C) 2011, Kolab Systems AG <contact@kolabsys.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 * @licend  The above is the entire license notice
 * for the JavaScript code in this file.
 */

window.rcmail && window.roundav_api && rcmail.addEventListener('init', function () {
    var hasAttachments = rcmail.env.attachments && Object.keys(rcmail.env.attachments).length > 0;

    if (rcmail.task == 'mail') {
        if (rcmail.env.action == 'compose') {
            var elem = $('#compose-attachments > div');
            var input = $(`<button class="btn btn-secondary attach cloud" type="button" tabindex="${$('button', elem).attr('tabindex') || 0}">
                ${rcmail.gettext('roundav.fromcloud')}
            </button>`).click(function () { roundav_selector_dialog(); });
            elem.append('<br />', input);

            if (rcmail.gui_objects.filelist) {
                rcmail.file_list = new rcube_list_widget(rcmail.gui_objects.filelist, {
                    multiselect: true,
                    keyboard: true,
                    column_movable: false,
                    dblclick_time: rcmail.dblclick_time,
                });
                rcmail.file_list.addEventListener('select', function (o) { roundav_list_select(o); })
                    .addEventListener('listupdate', function (e) { rcmail.triggerEvent('listupdate', e); });

                rcmail.enable_command('files-sort', 'files-search', 'files-search-reset', true);

                rcmail.file_list.init();
                roundav_list_coltypes();
            }

            // register some commands to skip warning message on compose page
            $.merge(rcmail.env.compose_commands, ['files-list', 'files-sort', 'files-search', 'files-search-reset']);
        }
        // mail preview
        else if ((rcmail.env.action == 'show' || rcmail.env.action == 'preview') && hasAttachments) {
            var header_links = $('#message-header .header-links');
            if (header_links.length) {
                header_links.append(
                    $(`<a href="#" class="button filesaveall">${rcmail.gettext('roundav.saveall')}</a>`)
                        .on('click', function () { roundav_directory_selector_dialog(); })
                );
            }

            rcmail.addEventListener('menu-open', roundav_attach_menu_open);
            rcmail.enable_command('folder-force-reload', true);
        }
        // attachment preview
        else if (rcmail.env.action == 'get') {
            rcmail.enable_command('folder-force-reload', true);
        }

        roundav_init();
    }
});


/**********************************************************/
/** *******          Shared functionality         **********/
/**********************************************************/

// Initializes API object
function roundav_init()
{
    if (window.roundav_file_api) { return; }

    // Initialize application object (don't change var name!)
    roundav_file_api = $.extend(new roundav_api(), new roundav_ui());

    roundav_file_api.set_env({
        // Seed from the session preference exported by the PHP side, so the very first
        // list request matches the sort indicator already drawn in the table header.
        // The fallback matters: roundav_init() also runs in the mail task, where the
        // files list was never rendered and these env vars are undefined.
        sort_col: rcmail.env.sort_col || 'name',
        sort_reverse: rcmail.env.sort_order == 'DESC',
        search_threads: rcmail.env.search_threads,
        resources_dir: rcmail.assets_path('program/resources'),
        supported_mimetypes: rcmail.env.file_mimetypes,
        expanding: {}, // paths with a lazy-expand request currently in flight
    });

    roundav_file_api.translations = rcmail.labels;
}


// folder selection dialog
function roundav_directory_selector_dialog(id)
{
    var dialog = $('#files-dialog');
    var input = $('#file-save-as-input');
    var form = $('#file-save-as');
    var buttons = {};
    var label = 'saveto';
    var fn;

    // attachment is specified
    if (id) {
        var attach = $('#attach' + id + '> a').first(),
            filename = attach.attr('title');

        if (!filename) {
            attach = attach.clone();
            $('.attachment-size', attach).remove();
            filename = attach.text();
        }

        form.show();
        dialog.addClass('saveas');
        input.val(filename);
    }
    // attachment preview page
    else if (rcmail.env.action == 'get') {
        id = rcmail.env.part;
        form.show();
        dialog.addClass('saveas');
        input.val(rcmail.env.filename);
    }
    else {
        form.hide();
        dialog.removeClass('saveas');
        label = 'saveall';
    }

    buttons[rcmail.gettext('roundav.save')] = function () {
        var lock = rcmail.set_busy(true, 'saving');
        var request = {
            act: 'save_file',
            source: rcmail.env.mailbox,
            uid: rcmail.env.uid,
            dest: roundav_file_api.env.folder,
        };

        if (id) {
            request.id = id;
            request.name = input.val();
        }

        rcmail.http_post('plugin.roundav', request, lock);
        roundav_dialog_close(this);
    };

    buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    if (!rcmail.env.folders_loaded) {
        fn = function () {
            roundav_file_api.folder_list();
            rcmail.env.folders_loaded = true;
        };
    }

    // show dialog window
    roundav_dialog_show(dialog, {
        title: rcmail.gettext('roundav.' + label),
        buttons: buttons,
        button_classes: ['mainaction'],
        minWidth: 300,
        minHeight: 300,
        height: 400,
        width: 500,
    }, fn);

    // "enable" folder refresh when dialog is displayed in parent window
    if (rcmail.is_framed()) {
        if (!parent.rcmail.folder_force_reload) {
            parent.rcmail.enable_command('folder-force-reload', true);
            parent.rcmail.folder_force_reload = function () {
                window.roundav_folder_force_reload();
            };
        }
    }
}

// file selection dialog
function roundav_selector_dialog()
{
    var dialog = $('#files-compose-dialog'), buttons = {};

    buttons[rcmail.gettext('roundav.attachsel')] = function () {
        var list = [];
        $('#filelist tr.selected').each(function () {
            list.push($(this).data('file'));
        });

        roundav_dialog_close(this);

        if (list.length) {
            // Display upload indicator and cancel button
            var id = Date.now();

            rcmail.add2attachment_list(id, {
                name: '',
                html: `<span>${rcmail.get_label('roundav.attaching')}</span>`,
                classname: 'uploading',
                complete: false,
            });

            // send request
            rcmail.http_post('plugin.roundav', {
                act: 'attach_file',
                files: list,
                id: rcmail.env.compose_id,
                uploadid: id,
            });
        }
    };

    buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    // show dialog window
    roundav_dialog_show(dialog, {
        title: rcmail.gettext('roundav.selectfiles'),
        buttons: buttons,
        button_classes: ['mainaction'],
        minWidth: 500,
        minHeight: 300,
        width: 700,
        height: 500,
    });

    if (!rcmail.env.files_loaded) {
        roundav_file_api.folder_list();
        rcmail.env.files_loaded = true;
    }
    else {
        rcmail.file_list.clear_selection();
    }
}

function roundav_attach_menu_open(p)
{
    if (!p || !p.props || p.props.menu != 'attachmentmenu') { return; }

    var id = p.props.id;

    $('#attachmenusaveas').unbind('click').attr('onclick', '').click(function (e) {
        return roundav_directory_selector_dialog(id);
    });
}

// Builds <option> elements for a parent-folder <select>, indented by depth.
// `all` is the flat list of folder display-paths from roundav_file_api.folder_list_all().
function roundav_folder_options(all, sep)
{
    var options = [];

    $.each(all, function (idx, path) {
        var parts = path.split(sep), depth = parts.length - 1,
            n, name = roundav_escapeHTML(parts.pop());

        for (n = 0; n < depth; n++) { name = '&nbsp;&nbsp;&nbsp;' + name; }

        options.push($('<option>').val(path).html(name));
    });

    return options;
}

// folder creation dialog. `parentPath` is always fixed by the caller (either a specific
// folder clicked via its "+" icon, or the root, from the retargeted toolbar button) — there
// is no free-choice parent picker, so no full-tree fetch is needed to populate one.
function roundav_folder_create_dialog(parentPath)
{
    var dialog = $('#files-folder-create-dialog'),
        buttons = {},
        select = $('select[name="parent"]', dialog).html(''),
        input = $('input[name="name"]', dialog).val('');

    buttons[rcmail.gettext('roundav.create')] = function () {
        var folder = '', name = input.val(), parent = select.val();

        if (!name) { return; }

        if (parent) { folder = parent + roundav_file_api.env.directory_separator; }

        folder += name;

        roundav_file_api.folder_create(folder);
        roundav_dialog_close(this);
    };

    buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    // show dialog window
    roundav_dialog_show(dialog, {
        title: rcmail.gettext('roundav.foldercreate'),
        buttons: buttons,
        button_classes: ['mainaction'],
    });

    // Fix submitting form with Enter
    $('form', dialog).submit(roundav_dialog_submit_handler);

    // Parent is fixed and read-only: a single pre-selected, disabled option. select.val()
    // still returns it correctly (we read it via jQuery, not native form submission).
    select.append($('<option>').val(parentPath).text(parentPath)).prop('disabled', true);
}

// folder edit dialog
function roundav_folder_edit_dialog()
{
    var dialog = $('#files-folder-edit-dialog'),
        buttons = {}, options = [],
        separator = roundav_file_api.env.directory_separator,
        arr = roundav_file_api.env.folder.split(separator),
        folder = arr.pop(),
        path = arr.join(separator),
        select = $('select[name="parent"]', dialog).html(''),
        input = $('input[name="name"]', dialog).val(folder);

    buttons[rcmail.gettext('roundav.save')] = function () {
        var folder = '', name = input.val(), parent = select.val();

        if (!name) { return; }

        if (parent) { folder = parent + separator; }

        folder += name;

        roundav_file_api.folder_rename(roundav_file_api.env.folder, folder);
        roundav_dialog_close(this);
    };

    buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    // show dialog window
    roundav_dialog_show(dialog, {
        title: rcmail.gettext('roundav.folderedit'),
        buttons: buttons,
        button_classes: ['mainaction'],
    });

    // Fix submitting form with Enter
    $('form', dialog).submit(roundav_dialog_submit_handler);

    // build parent selector from the complete folder list (the lazy tree is only partial)
    options.push($('<option>').val('').text('---'));
    var loadingOpt = $('<option>').prop('disabled', true).text(rcmail.gettext('loading'));
    select.append(options).append(loadingOpt);

    roundav_file_api.folder_list_all(function (all) {
        loadingOpt.remove();
        select.append(roundav_folder_options(all, roundav_file_api.env.directory_separator)).val(path);
    });
}

// folder mounting dialog
function roundav_folder_mount_dialog()
{
    var args = { buttons: {}, title: rcmail.gettext('roundav.foldermount') },
        dialog = $('#files-folder-mount-dialog'),
        input = $('#folder-mount-name').val('');

    args.buttons[rcmail.gettext('roundav.save')] = function () {
        var args = {}, folder = input.val(),
            driver = $('input[name="driver"]:checked', dialog).val();

        if (!folder || !driver) { return; }

        args.folder = folder;
        args.driver = driver;

        $('#source-' + driver + ' input').each(function () {
            if (this.name.startsWith(driver + '[')) {
                args[this.name.substring(driver.length + 1, this.name.length - 1)] = this.value;
            }
        });

        $('.auth-options input', dialog).each(function () {
            args[this.name] = this.type == 'checkbox' && !this.checked ? '' : this.value;
        });

        roundav_file_api.folder_mount(args);
        roundav_dialog_close(this);
    };

    args.buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    // close folderoption menu
    rcmail.hide_menu('folderoptions');

    // initialize drivers list
    if (!rcmail.drivers_list_initialized) {
        rcmail.drivers_list_initialized = true;

        $('td.source', dialog).each(function () {
            $(this).click(function () {
                $('td.selected', dialog).removeClass('selected');
                dialog.find('.driverform').hide();
                $(this).addClass('selected').find('.driverform').show();
                $('input[type="radio"]', this).prop('checked', true);
            });
        });
    }

    args.button_classes = ['mainaction'];

    // show dialog window
    roundav_dialog_show(dialog, args, function () {
        $('td.source:first', dialog).click();
        input.focus();
    });
}

// file edition dialog
function roundav_file_edit_dialog(file)
{
    var dialog = $('#files-file-edit-dialog'),
        buttons = {}, name = roundav_file_api.file_name(file);
    input = $('input[name="name"]', dialog).val(name);

    buttons[rcmail.gettext('roundav.save')] = function () {
        var folder = roundav_file_api.file_path(file), name = input.val();

        if (!name) { return; }

        name = folder + roundav_file_api.env.directory_separator + name;

        // @TODO: now we only update filename
        if (name != file) { roundav_file_api.file_rename(file, name); }
        roundav_dialog_close(this);
    };
    buttons[rcmail.gettext('roundav.cancel')] = function () {
        roundav_dialog_close(this);
    };

    // Fix submitting form with Enter
    $('form', dialog).submit(roundav_dialog_submit_handler);

    // show dialog window
    roundav_dialog_show(dialog, {
        title: rcmail.gettext('roundav.fileedit'),
        buttons: buttons,
        button_classes: ['mainaction'],
    });
}

function roundav_dialog_show(content, params, onopen)
{
    params = $.extend({
        modal: true,
        resizable: true,
        closeOnEscape: (!bw.ie6 && !bw.ie7), // disabled for performance reasons
        minWidth: 400,
        minHeight: 300,
        width: 500,
        height: 400,
    }, params || {});

    // dialog close handler
    params.close = function (e, ui) {
        var elem, stack = rcmail.dialog_stack;

        content.appendTo(document.body).hide();
        $(this).parent().remove(); // remove dialog

        // focus previously focused element (guessed)
        stack.pop();
        if (stack.length) {
            elem = stack[stack.length - 1].find('input[type!="hidden"]:not(:hidden):first');
            if (!elem.length) { elem = stack[stack.length - 1].parent().find('a[role="button"], .ui-dialog-buttonpane button').first(); }
        }

        (elem && elem.length ? elem : window).focus();
    };

    // display it as popup
    var dialog = rcmail.show_popup_dialog('', params.title, params.buttons, params);

    content.appendTo(dialog).show().find('input[type!="hidden"]:not(:hidden):first').focus();

    if (onopen) { onopen(content); }

    // save dialog reference, to handle focus when closing one of opened dialogs
    if (!rcmail.dialog_stack) { rcmail.dialog_stack = []; }

    rcmail.dialog_stack.push(dialog);
}

// Handle form submit with Enter key, click first dialog button instead
function roundav_dialog_submit_handler()
{
    $(this).parents('.ui-dialog').find('.ui-button').first().click();
    return false;
}

// Hides dialog
function roundav_dialog_close(dialog)
{
    (rcmail.is_framed() ? window.parent : window).$(dialog).dialog('close');
}

function roundav_folder_force_reload()
{
    roundav_file_api.folder_list(true);
}



/***********************************************************/
/** ********          Main functionality           **********/
/***********************************************************/

// for reordering column array (Konqueror workaround)
// and for setting some message list global variables
roundav_list_coltypes = function ()
{
    var n, list = rcmail.file_list;

    rcmail.env.subject_col = null;

    if ((n = $.inArray('name', rcmail.env.coltypes)) >= 0) {
        rcmail.env.subject_col = n;
        list.subject_col = n;
    }

    list.init_header();
};

roundav_list_select = function (list)
{
    var selected = list.selection.length;

    rcmail.enable_command(rcmail.env.file_commands_all, selected);
    rcmail.enable_command(rcmail.env.file_commands, selected == 1);

    // reset all-pages-selection
    //  if (list.selection.length && list.selection.length != list.rowcount)
    //    rcmail.select_all_mode = false;

    // enable files-
    if (selected == 1) {
    // get file mimetype
        var type = $('tr.selected', list.list).data('type');
        rcmail.env.viewer = roundav_file_api.file_type_supported(type);
    }
    else { rcmail.env.viewer = 0; }
    /*
    ) {
//      caps = this.browser_capabilities().join();
      href = '?' + $.param({_task: 'roundav', _action: 'open', file: file, viewer: viewer == 2 ? 1 : 0});
      var win = window.open(href, rcmail.html_identifier('rcubefile'+file));
      if (win)
        setTimeout(function() { win.focus(); }, 10);
    }
*/
    rcmail.enable_command('files-open', rcmail.env.viewer);
};

// returns localized file size
roundav_file_size = function (size)
{
    var i, units = ['GB', 'MB', 'KB', 'B'];

    size = roundav_file_api.file_size(size);

    for (i = 0; i < units.length; i++) { if (size.toUpperCase().indexOf(units[i]) > 0) { return size.replace(units[i], rcmail.gettext(units[i])); } }

    return size;
};

roundav_progress_str = function (param)
{
    var current, total = roundav_file_api.file_size(param.total).toUpperCase();

    if (total.indexOf('GB') > 0) { current = parseFloat(param.current / 1073741824).toFixed(1); }
    else if (total.indexOf('MB') > 0) { current = parseFloat(param.current / 1048576).toFixed(1); }
    else if (total.indexOf('KB') > 0) { current = parseInt(param.current / 1024); }
    else { current = param.current; }

    total = roundav_file_size(param.total);

    return rcmail.gettext('uploadprogress')
        .replace(/\$percent/, param.percent + '%')
        .replace(/\$current/, current)
        .replace(/\$total/, total);
};


/***********************************************************/
/** ********              Commands                 **********/
/***********************************************************/

rcube_webmail.prototype.files_sort = function (props)
{
    var params = {},
        sort_order = this.env.sort_order,
        sort_col = !this.env.disabled_sort_col ? props : this.env.sort_col;

    if (!this.env.disabled_sort_order) { sort_order = this.env.sort_col == sort_col && sort_order == 'ASC' ? 'DESC' : 'ASC'; }

    // set table header and update env
    this.set_list_sorting(sort_col, sort_order);

    this.http_post('files/prefs', { roundav_sort_col: sort_col, roundav_sort_order: sort_order });

    params.sort = sort_col;
    params.reverse = sort_order == 'DESC';

    this.command('files-list', params);
};

rcube_webmail.prototype.files_search = function ()
{
    var value = $(this.gui_objects.filesearchbox).val();

    if (value) { roundav_file_api.file_search(value, $('#search_all_folders').is(':checked')); }
    else { roundav_file_api.file_search_reset(); }
};

rcube_webmail.prototype.files_search_reset = function ()
{
    $(this.gui_objects.filesearchbox).val('');

    roundav_file_api.file_search_reset();
};

rcube_webmail.prototype.files_list = function (param)
{
    // just rcmail wrapper, to handle command busy states
    roundav_file_api.file_list(param);
};

rcube_webmail.prototype.files_list_update = function (head)
{
    var list = this.file_list;

    list.clear();
    $('thead', list.fixed_header ? list.fixed_header : list.list).html(head);
    roundav_list_coltypes();
    roundav_file_api.file_list();
};

rcube_webmail.prototype.files_set_quota = function (p)
{
    if (p.total && window.roundav_file_api) {
        p.used *= 1024;
        p.total *= 1024;
        p.title = roundav_file_api.file_size(p.used) + ' / ' + roundav_file_api.file_size(p.total)
        + ' (' + p.percent + '%)';
    }

    p.type = this.env.quota_type;

    this.set_quota(p);
};

rcube_webmail.prototype.folder_rename = function ()
{
    roundav_folder_edit_dialog();
};

rcube_webmail.prototype.folder_mount = function ()
{
    roundav_folder_mount_dialog();
};


/**********************************************************/
/** *******          Files API handler            **********/
/**********************************************************/

function roundav_ui()
{
    this.requests = {};
    this.uploads = [];

    /*
  // Called on "session expired" session
  this.logout = function(response) {};

  // called when a request timed out
  this.request_timed_out = function() {};

  // called on start of the request
  this.set_request_time = function() {};

  // called on request response
  this.update_request_time = function() {};
*/
    // set state
    this.set_busy = function (a, message)
    {
        if (this.req) { rcmail.hide_message(this.req); }

        return rcmail.set_busy(a, message);
    };

    // displays error message
    this.display_message = function (label, type)
    {
        return rcmail.display_message(this.t(label), type);
    };

    this.http_error = function (request, status, err)
    {
        var self = this;
        var elem = this._get_folder_list_element();
        if (elem.children('p.loading').length) {
            elem.empty();
        }

        // Roll back any folders whose lazy-expand request is in flight. A transport-level
        // failure never reaches folder_expand_response, so this is the only place that
        // clears env.expanding (the in-flight guard) for that case. Driven directly from
        // env.expanding rather than a DOM class, since that's the actual source of truth.
        Object.keys(this.env.expanding || {}).forEach(function (path) {
            var f = self.env.folders[path];
            if (f) {
                var el = self._folder_element(f);
                el.children('ul.subfolders').children('li.loading').remove();
                el.removeClass('expanded').addClass('collapsed');
            }
            delete self.env.expanding[path];
        });

        rcmail.http_error(request, status, err, this.req);
    };

    this._get_folder_list_element = function ()
    {
        var elem = $('#files-folder-list');
        // try parent window if the list element does not exist
        // i.e. called from dialog in parent window
        if (!elem.length && window.parent && parent.rcmail) {
            elem = $('#files-folder-list', window.parent.document.body);
        }

        return elem;
    };

    // folders list request
    this.folder_list = function (forceRefresh = false)
    {
        // Do not use rcmail.set_busy to display the loading message.
        this.req = rcmail.set_busy(true);

        // Prefer displaying it in the modal directly.
        var elem = this._get_folder_list_element();
        elem.html('<p class="loading"><span>Loading folders…</span></p>');

        // A full (re)load invalidates the cached flat list used by search/collections.
        this.env.all_folders = null;

        this.request('folder_list', {
            force_refresh: forceRefresh === true
        }, 'folder_list_response');
    };

    // folder list response handler
    this.folder_list_response = function (response)
    {
        var elem = this._get_folder_list_element();

        if (!this.response(response))
        {
            var errorMessage = response && response.reason ? response.reason : "Unknown error";
            elem.html(`<p>ERROR: ${errorMessage}</p>`)
            return;
        }

        var first;
        var list = $('<ul class="listing"></ul>');
        var collections = !rcmail.env.action.match(/^(preview|show)$/) ? ['audio', 'video', 'image', 'document'] : [];
        var result = response.result || {};

        // Fresh (root) load: reset the folders map and the id sequence.
        this.env.folder_seq = 1;
        this.env.folders = this.folder_list_parse(result.folders || result);

        // Build a genuinely nested tree: append each folder into its parent's <ul.subfolders>.
        // Backend returns parents before children, so a single ordered pass is enough.
        $.each(this.env.folders, function (path, f) {
            var row = roundav_file_api.folder_list_row(path, f);

            if (f.parent && roundav_file_api.env.folders[f.parent]) {
                $('#' + roundav_file_api.env.folders[f.parent].id + ' > ul.subfolders', list).append(row);
            }
            else {
                list.append(row);
                if (!first) { first = path; }
            }
        });

        // add virtual collections
        $.each(collections, function (i, n) {
            var row = $(`<li id="folder-collection-${n}" tabindex="0" class="mailbox collection ${n}">
                <span class="name">${rcmail.gettext(`roundav.collection_${n}`)}</span>
            </li>`);

            row.on('click', function () { roundav_file_api.folder_select(n, true); });

            list.append(row);
        });

        elem.html(list);

        // Expand the top level by default (or restore a previously-open state after a reload).
        this.folder_restore_expanded(first);

        // Select the previously-selected folder if it is present in the loaded subtree,
        // otherwise fall back to the first folder.
        if (this.env.folder && this.env.folders[this.env.folder]) { this.folder_select(this.env.folder); }
        else if (this.env.collection) { this.folder_select(this.env.collection, true); }
        else if (first) { this.folder_select(first); }

        // handle authentication errors on external sources
        this.folder_list_auth_errors(response.result);
    };

    // Expand the root node by default; on a reload, re-open branches that were open before
    // and still fit within the freshly-loaded subtree (pure CSS, no extra requests).
    this.folder_restore_expanded = function (rootPath)
    {
        var self = this, saved = this.env.expanded_paths || {};

        if (rootPath && this.env.folders[rootPath]) {
            this.folder_set_expanded(this.env.folders[rootPath], true);
        }

        Object.keys(saved).sort(function (a, b) { return a.length - b.length; }).forEach(function (p) {
            var f = self.env.folders[p];
            if (f && f.has_children && (f.loaded || !f.boundary)) {
                self.folder_set_expanded(f, true);
            }
        });
    };

    this.folder_select = function (folder, is_collection)
    {
        if (rcmail.busy) { return; }

        // Guard: the selected folder may sit below the loaded subtree after a reload.
        if (!is_collection && !this.env.folders[folder]) { return; }

        var list = this._get_folder_list_element().children('ul');

        $('li.selected', list).removeClass('selected');

        rcmail.enable_command('files-list', true);

        if (is_collection) {
            $('#folder-collection-' + folder, list).addClass('selected');

            rcmail.enable_command('files-folder-delete', 'folder-rename', 'files-upload', false);
            this.env.folder = null;
            rcmail.command('files-list', { collection: folder });
        }
        else {
            $('#' + this.env.folders[folder].id, list).addClass('selected');

            rcmail.enable_command('files-folder-delete', 'folder-rename', 'files-upload', true);
            this.env.folder = folder;
            this.env.collection = null;
            rcmail.command('files-list', { folder: folder });
        }

        this.quota();
    };

    this.folder_unselect = function ()
    {
        var list = this._get_folder_list_element().children('ul');
        $('li.selected', list).removeClass('selected');
        rcmail.enable_command('files-folder-delete', 'files-upload', false);
        this.env.folder = null;
        this.env.collection = null;
    };

    this.folder_list_row = function (i, folder)
    {
        var rowClasses = ["mailbox"];
        if (folder.has_children) {
            rowClasses.push("has-children", "collapsed");
        }

        var row = $(`<li id="${folder.id}" class="${rowClasses.join(" ")}">
            <span class="toggle"></span>
            <span class="name">${roundav_escapeHTML(folder.name)}</span>
        </li>`);

        row.data('folder', i);

        // Container for collapsible / lazily-loaded children.
        if (folder.has_children) {
            $('<ul class="subfolders" style="display:none"></ul>').appendTo(row);
        }

        // The toggle arrow expands/collapses (and lazy-loads) without selecting the folder.
        $('span.toggle', row).click(function (e) {
            e.stopPropagation();
            roundav_file_api.folder_toggle(i);
        });

        // Creates a subfolder directly under this (already-visible/loaded) folder, without
        // needing a free-choice parent picker (and so without a full-tree fetch). Not offered
        // when composing/attaching — that flow is attach-only, no folder management.
        if (rcmail.env.action != 'compose') {
            $(`<span class="create-subfolder" title="${roundav_escapeHTML(rcmail.gettext('roundav.createsubfolder'))}"></span>`)
                .appendTo(row)
                .click(function (e) {
                    e.stopPropagation();
                    roundav_folder_create_dialog(i);
                });
        }

        // Clicking the name selects the folder (loads its files).
        $('span.name', row).attr('tabindex', 0)
            .keypress(function (e) { if (e.which == 13 || e.which == 32) { roundav_file_api.folder_select(i); } })
            .click(function () { roundav_file_api.folder_select(i); })
            .mouseenter(function () {
                if (rcmail.file_list && rcmail.file_list.drag_active && !row.hasClass('selected')) { row.addClass('droptarget'); }
            })
            .mouseleave(function () {
                if (rcmail.file_list && rcmail.file_list.drag_active) { row.removeClass('droptarget'); }
            });

        return row;
    };

    // Resolve a folder's <li> element, checking the parent window for framed dialogs.
    this._folder_element = function (f)
    {
        var el = $('#' + f.id);
        if (!el.length && window.parent && parent.rcmail) {
            el = $('#' + f.id, window.parent.document.body);
        }
        return el;
    };

    // Track which folders are open so the tree can be restored after a reload.
    this._track_expanded = function (path, expanded)
    {
        if (!this.env.expanded_paths) { this.env.expanded_paths = {}; }
        if (expanded) { this.env.expanded_paths[path] = true; }
        else { delete this.env.expanded_paths[path]; }
    };

    // Show/hide a folder's children (pure CSS, no request).
    this.folder_set_expanded = function (f, expanded)
    {
        var el = this._folder_element(f), ul = el.children('ul.subfolders');

        if (expanded) {
            ul.show();
            el.removeClass('collapsed').addClass('expanded');
        }
        else {
            ul.hide();
            el.removeClass('expanded').addClass('collapsed');
        }

        f.expanded = expanded;
        this._track_expanded(f.path, expanded);
    };

    // Toggle a folder open/closed, lazy-loading the next batch when a boundary node is opened.
    this.folder_toggle = function (path)
    {
        var f = this.env.folders[path];
        if (!f || !f.has_children) { return; }

        if (f.expanded) {
            this.folder_set_expanded(f, false);
        }
        else if (f.loaded || !f.boundary) {
            // Children are already in the DOM (loaded within the current batch) -> just show them.
            this.folder_set_expanded(f, true);
        }
        else if (!this.env.expanding[path]) {
            // Boundary node: fetch the next batch of levels (unless already in flight).
            this.folder_expand(f);
        }
    };

    // Lazily fetch the subtree below a boundary folder, showing a per-node spinner.
    this.folder_expand = function (f)
    {
        var el = this._folder_element(f), ul = el.children('ul.subfolders');

        this.env.expanding[f.path] = true;

        // The spinner li inside ul.subfolders is the loading indicator; the row itself
        // just needs to be marked expanded.
        ul.html('<li class="loading"><span></span></li>').show();
        el.removeClass('collapsed').addClass('expanded');

        // The response always carries `result.base` (even on error), so concurrent
        // expansions of different folders stay independent. No `depth` is sent — the
        // server-side default (lib/roundav_files_engine.php) is the single source of
        // truth for the batch size, so every request path stays in sync with it.
        this.request('folder_list', { folder: f.path }, 'folder_expand_response');
    };

    // Handler for a lazy expand: graft the returned subtree into the target node.
    this.folder_expand_response = function (response)
    {
        var res = response && response.result ? response.result : {};
        var f = res.base ? this.env.folders[res.base] : null;
        var el = f ? this._folder_element(f) : $();
        var ul = el.children('ul.subfolders');

        if (res.base) { delete this.env.expanding[res.base]; }

        // Remove the per-node spinner.
        ul.children('li.loading').remove();

        if (!this.response(response)) {
            if (f) { this.folder_set_expanded(f, false); }
            return;
        }

        if (!f) { return; }

        var entries = res.folders || [];

        // Boundary folder that turned out to be empty -> demote to a leaf.
        if (!entries.length) {
            f.has_children = false;
            f.loaded = true;
            el.removeClass('has-children expanded collapsed');
            $('> span.toggle', el).remove();
            ul.remove();
            this._track_expanded(f.path, false);
            return;
        }

        var added = this.folder_list_parse(entries);
        $.extend(this.env.folders, added);
        this._graft_folders(added);

        f.loaded = true;
        this.folder_set_expanded(f, true);
    };

    // Append freshly-parsed folder rows into their parents' subfolder containers (in the live DOM).
    // Container lookups are cached by parent path since a batch typically shares one parent.
    this._graft_folders = function (folders)
    {
        var self = this, containers = {};

        function container_for(f) {
            var key = f.parent || '';
            if (!containers[key]) {
                var parent = f.parent ? self.env.folders[f.parent] : null;
                containers[key] = parent
                    ? self._folder_element(parent).children('ul.subfolders')
                    : self._get_folder_list_element().children('ul.listing');
            }
            return containers[key];
        }

        $.each(folders, function (path, f) {
            container_for(f).append(self.folder_list_row(path, f));
        });
    };

    // folder create request
    this.folder_create = function (folder)
    {
        this.req = this.set_busy(true, 'roundav.foldercreating');
        this.request('folder_create', { folder: folder }, 'folder_create_response');
    };

    // folder create response handler
    this.folder_create_response = function (response)
    {
        if (!this.response(response)) { return; }

        this.display_message('roundav.foldercreatenotice', 'confirmation');

        // refresh folders list
        this.folder_list();
    };

    // folder rename request
    this.folder_rename = function (folder, new_name)
    {
        if (folder == new_name) { return; }

        this.env.folder_rename = new_name;
        this.req = this.set_busy(true, 'roundav.folderupdating');
        this.request('folder_move', { folder: folder, new: new_name }, 'folder_rename_response');
    };

    // folder create response handler
    this.folder_rename_response = function (response)
    {
        if (!this.response(response)) { return; }

        this.display_message('roundav.folderupdatenotice', 'confirmation');

        // refresh folders and files list
        this.env.folder = this.env.folder_rename;
        this.folder_list(true);
    };

    // folder mount (external storage) request
    this.folder_mount = function (data)
    {
        this.req = this.set_busy(true, 'roundav.foldermounting');
        this.request('folder_create', data, 'folder_mount_response');
    };

    // folder create response handler
    this.folder_mount_response = function (response)
    {
        if (!this.response(response)) { return; }

        this.display_message('roundav.foldermountnotice', 'confirmation');

        // refresh folders list
        this.folder_list(true);
    };

    // folder delete request
    this.folder_delete = function (folder)
    {
        this.req = this.set_busy(true, 'roundav.folderdeleting');
        this.request('folder_delete', { folder: folder }, 'folder_delete_response');
    };

    // folder delete response handler
    this.folder_delete_response = function (response)
    {
        if (!this.response(response)) { return; }

        this.env.folder = null;
        rcmail.enable_command('files-folder-delete', 'folder-rename', 'files-list', false);
        this.display_message('roundav.folderdeletenotice', 'confirmation');

        // refresh folders list
        this.folder_list(true);
        this.quota();
    };

    // quota request
    this.quota = function ()
    {
        if (rcmail.env.files_quota) { this.request('quota', { folder: this.env.folder }, 'quota_response'); }
    };

    // quota response handler
    this.quota_response = function (response)
    {
        if (!this.response(response)) { return; }

        rcmail.files_set_quota(response.result);
    };

    this.file_list = function (params)
    {
        if (!rcmail.gui_objects.filelist) { return; }

        if (!params) { params = {}; }

        // reset all pending list requests
        for (i in this.requests) {
            this.requests[i].abort();
            rcmail.hide_message(i);
            delete this.requests[i];
        }

        if (params.all_folders) {
            params.collection = null;
            params.folder = null;
            this.folder_unselect();
        }

        if (params.collection == undefined) { params.collection = this.env.collection; }
        if (params.folder == undefined) { params.folder = this.env.folder; }
        if (params.sort == undefined) { params.sort = this.env.sort_col; }
        if (params.reverse == undefined) { params.reverse = this.env.sort_reverse; }
        if (params.search == undefined) { params.search = this.env.search; }

        this.env.folder = params.folder;
        this.env.collection = params.collection;
        this.env.sort_col = params.sort;
        this.env.sort_reverse = params.reverse;

        rcmail.enable_command(rcmail.env.file_commands, false);
        rcmail.enable_command(rcmail.env.file_commands_all, false);

        // empty the list
        this.env.file_list = [];
        rcmail.file_list.clear(true);

        // request
        if (params.collection || params.all_folders) { this.file_list_loop(params); }
        else if (this.env.folder) {
            params.req_id = this.set_busy(true, 'loading');
            this.requests[params.req_id] = this.request('file_list', params, 'file_list_response');
        }
    };

    // file list response handler
    this.file_list_response = function (response)
    {
        if (response.req_id) { rcmail.hide_message(response.req_id); }

        if (!this.response(response)) { return; }

        var i = 0, list = [], table = $('#filelist');

        $.each(response.result, function (key, data) {
            var row = roundav_file_api.file_list_row(key, data, ++i);
            rcmail.file_list.insert_row(row);
            data.row = row;
            data.filename = key;
            list.push(data);
        });

        this.env.file_list = list;
        rcmail.file_list.resize();
    };

    // call file_list request for every folder (used for search and virt. collections)
    // Fetches the COMPLETE folder list first (lazy tree only knows the expanded subset).
    this.file_list_loop = function (params)
    {
        var self = this;
        this.folder_list_all(function (all) { self._file_list_loop_run(params, all); });
    };

    this._file_list_loop_run = function (params, all)
    {
        var i, folders = [], limit = Math.max(this.env.search_threads || 1, 1);

        if (params.collection) {
            if (!params.search) { params.search = {}; }
            params.search.class = params.collection;
            delete params.collection;
        }

        delete params.all_folders;

        $.each(all || [], function (idx, path) { folders.push(path); });

        this.env.folders_loop = folders;
        this.env.folders_loop_params = params;
        this.env.folders_loop_lock = false;

        for (i = 0; i < folders.length && i < limit; i++) {
            params.req_id = this.set_busy(true, 'loading');
            params.folder = folders.shift();
            this.requests[params.req_id] = this.request('file_list', params, 'file_list_loop_response');
        }
    };

    // file list response handler for loop'ed request
    this.file_list_loop_response = function (response)
    {
        var i, folders = this.env.folders_loop,
            params = this.env.folders_loop_params,
            limit = Math.max(this.env.search_threads || 1, 1),
            valid = this.response(response);

        if (response.req_id) { rcmail.hide_message(response.req_id); }

        for (i = 0; i < folders.length && i < limit; i++) {
            params.req_id = this.set_busy(true, 'loading');
            params.folder = folders.shift();
            this.requests[params.req_id] = this.request('file_list', params, 'file_list_loop_response');
        }

        rcmail.file_list.resize();

        if (!valid) { return; }

        this.file_list_loop_result_add(response.result);
    };

    // add files from list request to the table (with sorting)
    this.file_list_loop_result_add = function (result)
    {
    // chack if result (hash-array) is empty
        if (!roundav_object_is_empty(result)) { return; }

        if (this.env.folders_loop_lock) {
            setTimeout(function () { roundav_file_api.file_list_loop_result_add(result); }, 100);
            return;
        }

        // lock table, other list responses will wait
        this.env.folders_loop_lock = true;

        var n, i, len, elem, list = [], rows = [],
            index = this.env.file_list.length,
            table = rcmail.file_list;

        for (n = 0, len = index; n < len; n++) {
            elem = this.env.file_list[n];
            for (i in result) {
                if (this.sort_compare(elem, result[i]) < 0) { break; }

                var row = this.file_list_row(i, result[i], ++index);
                table.insert_row(row, elem.row);
                result[i].row = row;
                result[i].filename = i;
                list.push(result[i]);
                delete result[i];
            }

            list.push(elem);
        }

        // add the rest of rows
        $.each(result, function (key, data) {
            var row = roundav_file_api.file_list_row(key, data, ++index);
            table.insert_row(row);
            result[key].row = row;
            result[key].filename = key;
            list.push(result[key]);
        });

        this.env.file_list = list;
        this.env.folders_loop_lock = false;
    };

    this.file_list_row = function (file, data, index)
    {
        var c, col, row = '';

        for (c in rcmail.env.coltypes) {
            c = rcmail.env.coltypes[c];
            if (c == 'name') { col = '<td class="name filename ' + this.file_type_class(data.type) + '">'
          + '<span>' + roundav_escapeHTML(data.name) + '</span></td>'; }
            else if (c == 'mtime') { col = '<td class="mtime">' + data.mtime + '</td>'; }
            else if (c == 'size') { col = '<td class="size">' + this.file_size(data.size) + '</td>'; }
            else if (c == 'options') { col = '<td class="options"><span></span></td>'; }
            else { col = '<td class="' + c + '"></td>'; }

            row += col;
        }

        row = $('<tr>')
            .html(row)
            .attr({ id: 'rcmrow' + index, 'data-file': file, 'data-type': data.type });

        $('td.options > span', row).click(function (e) {
            roundav_file_edit_dialog(file);
        });

        // collection (or search) lists files from all folders
        // display file name with full path as title
        if (!this.env.folder) { $('td.name span', row).attr('title', file); }

        return row.get(0);
    };

    this.file_search = function (value, all_folders)
    {
        if (value) {
            this.env.search = { name: value };
            rcmail.command('files-list', { search: this.env.search, all_folders: all_folders });
        }
        else { this.search_reset(); }
    };

    this.file_search_reset = function ()
    {
        if (this.env.search) {
            this.env.search = null;
            rcmail.command('files-list');
        }
    };

    this.file_get = function (file, params)
    {
        if (!params) { params = {}; }

        rcmail.redirect(rcmail.url('roundav/roundav_api') + '&method=file_get&file=' + file);
    };

    // file(s) delete request
    this.file_delete = function (files)
    {
        this.req = this.set_busy(true, 'roundav.filedeleting');
        this.request('file_delete', { file: files }, 'file_delete_response');
    };

    // file(s) delete response handler
    this.file_delete_response = function (response)
    {
        if (!this.response(response)) { return; }

        var rco, dir, self = this;

        this.display_message('roundav.filedeletenotice', 'confirmation');

        if (rcmail.env.file) {
            rco = rcmail.opener();
            dir = this.file_path(rcmail.env.file);

            // check if opener window contains files list, if not we can just close current window
            if (rco && rco.file_list && (opener.roundav_file_api.env.folder == dir || !opener.roundav_file_api.env.folder)) { self = opener.roundav_file_api; }
            else { window.close(); }
        }

        // @TODO: consider list modification "in-place" instead of full reload
        self.file_list();
        self.quota();

        if (rcmail.env.file) { window.close(); }
    };

    // file(s) move request
    this.file_move = function (files, folder)
    {
        if (!files || !files.length || !folder) { return; }

        var count = 0, list = {};

        $.each(files, function (i, v) {
            var name = folder + roundav_file_api.env.directory_separator + roundav_file_api.file_name(v);

            if (name != v) {
                list[v] = name;
                count++;
            }
        });

        if (!count) { return; }

        this.req = this.set_busy(true, 'roundav.filemoving');
        this.request('file_move', { file: list }, 'file_move_response');
    };

    // file(s) move response handler
    this.file_move_response = function (response)
    {
        if (!this.response(response)) { return; }

        if (response.result && response.result.already_exist && response.result.already_exist.length) { this.file_move_ask_user(response.result.already_exist, true); }
        else {
            this.display_message('roundav.filemovenotice', 'confirmation');
            this.file_list();
        }
    };

    // file(s) copy request
    this.file_copy = function (files, folder)
    {
        if (!files || !files.length || !folder) { return; }

        var count = 0, list = {};

        $.each(files, function (i, v) {
            var name = folder + roundav_file_api.env.directory_separator + roundav_file_api.file_name(v);

            if (name != v) {
                list[v] = name;
                count++;
            }
        });

        if (!count) { return; }

        this.req = this.set_busy(true, 'roundav.filecopying');
        this.request('file_copy', { file: list }, 'file_copy_response');
    };

    // file(s) copy response handler
    this.file_copy_response = function (response)
    {
        if (!this.response(response)) { return; }

        if (response.result && response.result.already_exist && response.result.already_exist.length) { this.file_move_ask_user(response.result.already_exist); }
        else {
            this.display_message('roundav.filecopynotice', 'confirmation');
            this.quota();
        }
    };

    // when file move/copy operation returns file-exists error
    // this displays a dialog where user can decide to skip
    // or overwrite destination file(s)
    this.file_move_ask_user = function (list, move)
    {
        var file = list[0], buttons = {},
            text = rcmail.gettext('roundav.filemoveconfirm').replace('$file', file.dst);
        dialog = $('<div></div>');

        buttons[rcmail.gettext('roundav.fileoverwrite')] = function () {
            var file = list.shift(), f = {},
                action = move ? 'file_move' : 'file_copy';

            f[file.src] = file.dst;
            roundav_file_api.file_move_ask_list = list;
            roundav_file_api.file_move_ask_mode = move;
            dialog.dialog('destroy').remove();
            roundav_file_api.req = roundav_file_api.set_busy(true, move ? 'roundav.filemoving' : 'roundav.filecopying');
            roundav_file_api.request(action, { file: f, overwrite: 1 }, 'file_move_ask_user_response');
        };

        if (list.length > 1) { buttons[rcmail.gettext('roundav.fileoverwriteall')] = function () {
            var f = {}, action = move ? 'file_move' : 'file_copy';

            $.each(list, function () { f[this.src] = this.dst; });
            dialog.dialog('destroy').remove();
            roundav_file_api.req = roundav_file_api.set_busy(true, move ? 'roundav.filemoving' : 'roundav.filecopying');
            roundav_file_api.request(action, { file: f, overwrite: 1 }, action + '_response');
        }; }

        var skip_func = function () {
            list.shift();
            dialog.dialog('destroy').remove();

            if (list.length) { roundav_file_api.file_move_ask_user(list, move); }
            else if (move) { roundav_file_api.file_list(); }
        };

        buttons[rcmail.gettext('roundav.fileskip')] = skip_func;

        if (list.length > 1) { buttons[rcmail.gettext('roundav.fileskipall')] = function () {
            dialog.dialog('destroy').remove();
            if (move) { roundav_file_api.file_list(); }
        }; }

        // open jquery UI dialog
        roundav_dialog_show(dialog.html(text), {
            close: skip_func,
            buttons: buttons,
            minWidth: 400,
            width: 400,
        });
    };

    // file move (with overwrite) response handler
    this.file_move_ask_user_response = function (response)
    {
        var move = this.file_move_ask_mode, list = this.file_move_ask_list;

        this.response(response);

        if (list && list.length) { this.file_move_ask_user(list, mode); }
        else {
            this.display_message('roundav.file' + (move ? 'move' : 'copy') + 'notice', 'confirmation');
            if (move) { this.file_list(); }
        }
    };

    // file(s) rename request
    this.file_rename = function (oldfile, newfile)
    {
        this.req = this.set_busy(true, 'roundav.fileupdating');
        this.request('file_move', { file: oldfile, new: newfile }, 'file_rename_response');
    };

    // file(s) move response handler
    this.file_rename_response = function (response)
    {
        if (!this.response(response)) { return; }

        // @TODO: we could update metadata instead
        this.file_list();
    };

    // file upload request
    this.file_upload = function (form)
    {
        var form = $(form),
            field = $('input[type=file]', form).get(0),
            files = field.files ? field.files.length : field.value ? 1 : 0;

        if (!files || !this.file_upload_size_check(field.files)) { return; }

        // submit form and read server response
        this.file_upload_form(form, 'file_upload', function (event) {
            var doc, response;
            try {
                doc = this.contentDocument ? this.contentDocument : this.contentWindow.document;
                response = doc.body.innerHTML;
                // response may be wrapped in <pre> tag
                if (response.slice(0, 5).toLowerCase() == '<pre>' && response.slice(-6).toLowerCase() == '</pre>') {
                    response = doc.body.firstChild.firstChild.nodeValue;
                }
                response = eval('(' + response + ')');
            }
            catch (err) {
                response = { status: 'ERROR' };
            }

            roundav_file_api.file_upload_progress_stop(event.data.ts);

            // refresh the list on upload success
            roundav_file_api.file_upload_response(response);
        });
    };

    // refresh the list on upload success
    this.file_upload_response = function (response)
    {
        if (this.response_parse(response)) {
            this.file_list();
            this.quota();
        }
    };

    // check upload max size
    this.file_upload_size_check = function (files)
    {
        var i, size = 0, maxsize = rcmail.env.files_max_upload;

        if (maxsize && files) {
            for (i = 0; i < files.length; i++) { size += files[i].size || files[i].fileSize; }

            if (size > maxsize) {
                alert(rcmail.get_label('roundav.uploadsizeerror').replace('$size', roundav_file_size(maxsize)));
                return false;
            }
        }

        return true;
    };

    // post the given form to a hidden iframe
    this.file_upload_form = function (form, action, onload)
    {
        var ts = new Date().getTime(),
            frame_name = 'fileupload' + ts;

        // upload progress support
        if (rcmail.env.files_progress_name) {
            var fname = rcmail.env.files_progress_name,
                field = $('input[name=' + fname + ']', form);

            if (!field.length) {
                field = $('<input>').attr({ type: 'hidden', name: fname });
                field.prependTo(form);
            }

            field.val(ts);
            this.file_upload_progress(ts, true);
        }

        rcmail.display_progress({ name: ts });

        // have to do it this way for IE
        // otherwise the form will be posted to a new window
        if (document.all) {
            var html = '<iframe id="' + frame_name + '" name="' + frame_name + '"'
        + ' src="' + rcmail.assets_path('program/resources/blank.gif') + '"'
        + ' style="width:0;height:0;visibility:hidden;"></iframe>';
            document.body.insertAdjacentHTML('BeforeEnd', html);
        }
        // for standards-compliant browsers
        else { $('<iframe>')
            .attr({ name: frame_name, id: frame_name })
            .css({
                border: 'none', width: 0, height: 0, visibility: 'hidden',
            })
            .appendTo(document.body); }

        // handle upload errors, parsing iframe content in onload
        $('#' + frame_name).on('load', { ts: ts }, onload);

        $(form).attr({
            target: frame_name,
            action: this.env.url + this.url(action, { folder: this.env.folder, token: this.env.token }),
            method: 'POST',
        }).attr(form.encoding ? 'encoding' : 'enctype', 'multipart/form-data')
            .submit();
    };

    // handler when files are dropped to a designated area.
    // compose a multipart form data and submit it to the server
    this.file_drop = function (e)
    {
        var files = e.target.files || e.dataTransfer.files;

        if (!files || !files.length || !this.file_upload_size_check(files)) { return; }

        // prepare multipart form data composition
        var ts = new Date().getTime(),
            formdata = window.FormData ? new FormData() : null,
            fieldname = 'file[]',
            boundary = '------multipartformboundary' + (new Date()).getTime(),
            dashdash = '--', crlf = '\r\n',
            multipart = dashdash + boundary + crlf;

        // inline function to submit the files to the server
        var submit_data = function () {
            var multiple = files.length > 1;

            rcmail.display_progress({ name: ts });
            if (rcmail.env.files_progress_name) { roundav_file_api.file_upload_progress(ts, true); }

            // complete multipart content and post request
            multipart += dashdash + boundary + dashdash + crlf;

            $.ajax({
                type: 'POST',
                dataType: 'json',
                url: roundav_file_api.env.url + roundav_file_api.url('file_upload', { folder: roundav_file_api.env.folder }),
                contentType: formdata ? false : 'multipart/form-data; boundary=' + boundary,
                processData: false,
                timeout: 0, // disable default timeout set in ajaxSetup()
                data: formdata || multipart,
                headers: { 'X-Session-Token': roundav_file_api.env.token },
                success: function (data) {
                    roundav_file_api.file_upload_progress_stop(ts);
                    roundav_file_api.file_upload_response(data);
                },
                error: function (o, status, err) {
                    roundav_file_api.file_upload_progress_stop(ts);
                    rcmail.http_error(o, status, err);
                },
                xhr: function () {
                    var xhr = jQuery.ajaxSettings.xhr();
                    if (!formdata && xhr.sendAsBinary) { xhr.send = xhr.sendAsBinary; }
                    return xhr;
                },
            });
        };

        // upload progress supported (and handler exists)
        // add progress ID to the request - need to be added before files
        if (rcmail.env.files_progress_name) {
            if (formdata) { formdata.append(rcmail.env.files_progress_name, ts); }
            else { multipart += 'Content-Disposition: form-data; name="' + rcmail.env.files_progress_name + '"'
          + crlf + crlf + ts + crlf + dashdash + boundary + crlf; }
        }

        // get contents of all dropped files
        var f, j, i = 0, last = files.length - 1;
        for (j = 0; j <= last && (f = files[i]); i++) {
            if (!f.name) { f.name = f.fileName; }
            if (!f.size) { f.size = f.fileSize; }
            if (!f.type) { f.type = 'application/octet-stream'; }

            // file name contains non-ASCII characters, do UTF8-binary string conversion.
            if (!formdata && /[^\u0020-\u007E]/.test(f.name)) { f.name_bin = unescape(encodeURIComponent(f.name)); }

            // do it the easy way with FormData (FF 4+, Chrome 5+, Safari 5+)
            if (formdata) {
                formdata.append(fieldname, f);
                if (j == last) { return submit_data(); }
            }
            // use FileReader supporetd by Firefox 3.6
            else if (window.FileReader) {
                var reader = new FileReader();

                // closure to pass file properties to async callback function
                reader.onload = (function (file, j) {
                    return function (e) {
                        multipart += 'Content-Disposition: form-data; name="' + fieldname + '"';
                        multipart += '; filename="' + (f.name_bin || file.name) + '"' + crlf;
                        multipart += 'Content-Length: ' + file.size + crlf;
                        multipart += 'Content-Type: ' + file.type + crlf + crlf;
                        multipart += reader.result + crlf;
                        multipart += dashdash + boundary + crlf;

                        if (j == last) // we're done, submit the data
                        { return submit_data(); }
                    };
                })(f, j);
                reader.readAsBinaryString(f);
            }

            j++;
        }
    };

    // upload progress requests
    this.file_upload_progress = function (id, init)
    {
        if (init && id) { this.uploads[id] = this.env.folder; }

        setTimeout(function () {
            if (id && roundav_file_api.uploads[id]) { roundav_file_api.request('upload_progress', { id: id }, 'file_upload_progress_response'); }
        }, rcmail.env.files_progress_time * 1000);
    };

    // upload progress response
    this.file_upload_progress_response = function (response)
    {
        if (!this.response(response)) { return; }

        var param = response.result;

        if (!param.id || !this.uploads[param.id]) { return; }

        if (param.total) {
            param.name = param.id;

            if (!param.done) { param.text = roundav_progress_str(param); }

            rcmail.display_progress(param);
        }

        if (!param.done && param.total) { this.file_upload_progress(param.id); }
        else { delete this.uploads[param.id]; }
    };

    this.file_upload_progress_stop = function (id)
    {
        if (id) {
            delete this.uploads[id];
            rcmail.display_progress({ name: id });
        }
    };

    // open file in new window, using file API viewer
    this.file_open = function (file, viewer)
    {
        var href = '?' + $.param({
            _task: 'roundav', _action: 'open', file: file, viewer: viewer == 2 ? 1 : 0,
        });
        rcmail.open_window(href, false, true);
    };

    // save file
    this.file_save = function (file, content)
    {
        rcmail.enable_command('files-save', false);
        // because we currently can edit only text files
        // and we do not expect them to be very big, we save
        // file in a very simple way, no upload progress, etc.
        this.req = this.set_busy(true, 'saving');
        this.request('file_update', { file: file, content: content, info: 1 }, 'file_save_response');
    };

    // file save response handler
    this.file_save_response = function (response)
    {
        rcmail.enable_command('files-save', true);

        if (!this.response(response)) { return; }

        // update file properties table
        var table = $('#fileinfobox table'), file = response.result;

        if (file) {
            $('td.filetype', table).text(file.type);
            $('td.filesize', table).text(this.file_size(file.size));
            $('td.filemtime', table).text(file.mtime);
        }
    };

    // handle auth errors on folder list
    this.folder_list_auth_errors = function (result)
    {
        if (result && result.auth_errors) {
            if (!this.auth_errors) { this.auth_errors = {}; }

            $.extend(this.auth_errors, result.auth_errors);
        }

        // ask for password to the first storage on the list
        $.each(this.auth_errors || [], function (i, v) {
            roundav_file_api.folder_list_auth_dialog(i, v);
            return false;
        });
    };

    // create dialog for user credentials of external storage
    this.folder_list_auth_dialog = function (label, driver)
    {
        var args = { width: 400, height: 300, buttons: {} },
            dialog = $('#files-folder-auth-dialog'),
            content = this.folder_list_auth_form(driver);

        dialog.find('table.propform').remove();
        $('.auth-options', dialog).before(content);

        args.buttons[this.t('roundav.save')] = function () {
            var data = { folder: label, list: 1 };

            $('input', dialog).each(function () {
                data[this.name] = this.type == 'checkbox' && !this.checked ? '' : this.value;
            });

            roundav_file_api.open_dialog = this;
            roundav_file_api.req = roundav_file_api.set_busy(true, 'roundav.authenticating');
            roundav_file_api.request('folder_auth', data, 'folder_auth_response');
        };

        args.buttons[this.t('roundav.cancel')] = function () {
            delete roundav_file_api.auth_errors[label];
            roundav_dialog_close(this);
            // go to the next one
            roundav_file_api.folder_list_auth_errors();
        };

        args.title = this.t('roundav.folderauthtitle').replace('$title', label);

        // show dialog window
        roundav_dialog_show(dialog, args, function () {
            // focus first empty input
            $('input', dialog).each(function () {
                if (!this.value) {
                    this.focus();
                    return false;
                }
            });
        });
    };

    // folder_auth handler
    this.folder_auth_response = function (response)
    {
        if (!this.response(response)) { return; }

        var folder = response.result.folder;

        delete this.auth_errors[folder];
        roundav_dialog_close(this.open_dialog);

        // go to the next one
        this.folder_list_auth_errors();

        // reload the tree so the freshly-authenticated source appears
        this.folder_list(true);
    };

    // returns content of the external storage authentication form
    this.folder_list_auth_form = function (driver)
    {
        var rows = [];

        $.each(driver.form, function (fi, fv) {
            var id = 'authinput' + fi,
                attrs = {
                    type: fi.match(/pass/) ? 'password' : 'text', size: 25, name: fi, id: id,
                },
                input = $('<input>').attr(attrs);

            if (driver.form_values && driver.form_values[fi]) { input.attr({ value: driver.form_values[fi] }); }

            rows.push($('<tr>')
                .append($('<td class="title">').append($('<label>').attr('for', id).text(fv)))
                .append($('<td>').append(input))
            );
        });

        return $('<table class="propform">').append(rows);
    };
}
