<?php

use Sabre\DAV\Client;
use League\Flysystem\Filesystem;
use League\FlySystem\StorageAttributes;
require_once __DIR__ . '/PatchedWebDAVAdapter.php';
class roundav_files_engine
{
    /**
     * @var roundav
     */
    private $plugin;

    private $sort_cols = array('name', 'mtime', 'size');

    /**
     * Bump when the shape, the ordering *or the content* of the cached folder lists changes, so
     * sessions created by an older plugin version never serve stale data.
     * v3: paths are no longer double-decoded ("C++" was cached as "C  ").
     */
    private const FOLDER_CACHE_VERSION = 3;

    /**
     *
     * @var Filesystem
     */
    protected $filesystem;

    const API_VERSION = 2;


    /**
     * Class constructor
     */
    public function __construct($plugin)
    {
        $this->plugin = $plugin;

        $url = $plugin->rc->config->get('driver_webdav_url');
        if (empty($url)) {
            return; // Not configured; filesystem stays null
        }

        $settings = array(
            'baseUri'  => $url,
            'userName' => $plugin->rc->config->get('driver_webdav_username') ?: $plugin->rc->user->get_username(),
            'password' => $plugin->rc->config->get('driver_webdav_password') ?: $plugin->rc->get_user_password(),
        );

        $client = new Client($settings);

        $curl_http_version = $plugin->rc->config->get('driver_curl_http_version');
        if ($curl_http_version !== null) {
            $client->addCurlSetting(CURLOPT_HTTP_VERSION, (int) $curl_http_version);
        }

        $adapter = new PatchedWebDAVAdapter($client, $plugin->rc->config->get('driver_webdav_prefix'));
        $this->filesystem = new Filesystem($adapter);
    }

    /**
     * Returns false and sends a JSON error response if the filesystem is not configured.
     */
    private function require_filesystem(array $result): bool
    {
        if ($this->filesystem !== null) {
            return true;
        }
        $result['status'] = 'NOK';
        $result['reason'] = 'not_configured';
        echo json_encode($result);
        exit();
    }

    /**
     * Ranks a set of plain names (single path segments, no separator) using Roundcube's own
     * folder comparator — rcube_imap::sort_folder_comparator(), reached through the public
     * sort_folder_list() — so files and folders order exactly like the mailbox list does.
     *
     * That comparator is locale-aware but *case-sensitive* ("Zulu" before "alpha"), which is
     * accepted here on purpose: matching the rest of the UI beats inventing a second ordering.
     *
     * Ranking up front rather than comparing pairwise keeps it to one call per listing instead
     * of one per comparison.
     *
     * @param string[] $names
     *
     * @return array<string,int> name => rank
     */
    private function name_ranks(array $names)
    {
        // sort_folder_list() keys its working array by name, so duplicates would collapse.
        // Make that explicit so the returned map still covers every input name.
        $names = array_values(array_unique($names));

        // sort_folder_comparator() explode()s on the IMAP hierarchy delimiter, which the
        // rcube_imap constructor only knows from the session. Without it that explode() would
        // fail, so fall back to the plain locale compare the comparator itself degrades to.
        if (empty($_SESSION['imap_delimiter'])) {
            usort($names, 'strcoll');
        }
        else {
            // skip_special: these are not mailboxes, so no INBOX/namespace re-ordering.
            $names = $this->plugin->rc->get_storage()->sort_folder_list($names, true);
        }

        return array_flip($names);
    }

    /**
     * Orders a list of full display paths. Ranks every distinct segment with name_ranks(), then
     * compares segment by segment so a folder always sorts immediately before its own
     * descendants: a naive sort() would place "Files/a-b" between "Files/a" and "Files/a/b"
     * ('-' 0x2D < '/' 0x2F), which breaks the indentation-by-depth rendering in
     * roundav_folder_options() (roundav.js). Splitting here rather than letting the comparator
     * do it also keeps the result independent of the IMAP hierarchy delimiter.
     *
     * @param string[] $paths
     *
     * @return string[]
     */
    private function sort_paths(array $paths)
    {
        $split    = array();
        $segments = array();

        foreach ($paths as $path) {
            $split[$path] = explode('/', $path);
            foreach ($split[$path] as $segment) {
                $segments[] = $segment;
            }
        }

        $ranks = $this->name_ranks($segments);

        usort($paths, function ($a, $b) use ($split, $ranks) {
            $pa = $split[$a];
            $pb = $split[$b];
            $n  = min(count($pa), count($pb));

            for ($i = 0; $i < $n; $i++) {
                if ($pa[$i] !== $pb[$i]) {
                    return $ranks[$pa[$i]] <=> $ranks[$pb[$i]];
                }
            }

            // One path is a prefix of the other: the shorter (the ancestor) comes first.
            return count($pa) <=> count($pb);
        });

        return $paths;
    }

    /**
     * Adds the roundav section to the preferences section list.
     */
    public function prefs_list($args)
    {
        $this->plugin->add_texts('localization/');
        $rc = $this->plugin->rc;
        $dont_override = (array) $rc->config->get('dont_override');

        $fields = array(
            'driver_webdav_url'      => array('type' => 'text',     'label' => 'webdav_url'),
            'driver_webdav_prefix'   => array('type' => 'text',     'label' => 'webdav_prefix'),
            'driver_webdav_username' => array('type' => 'text',     'label' => 'webdav_username'),
            'driver_webdav_password' => array('type' => 'password', 'label' => 'webdav_password'),
        );

        $args['blocks']['main']['name'] = rcube::Q($this->plugin->gettext('settings_section'));

        foreach ($fields as $key => $field) {
            if (in_array($key, $dont_override)) {
                continue;
            }

            $attrib = array(
                'name'         => '_' . $key,
                'id'           => 'ff_' . $key,
                'type'         => $field['type'],
                'class'        => 'form-control',
                'autocomplete' => 'off',
            );

            $input = new html_inputfield($attrib);
            $value = $field['type'] === 'password' ? '' : $rc->config->get($key, '');

            $args['blocks']['main']['options'][$key] = array(
                'title'   => html::label('ff_' . $key, rcube::Q($this->plugin->gettext($field['label']))),
                'content' => $input->show($value),
            );
        }

        return $args;
    }

    /**
     * Saves roundav preferences submitted from the settings form.
     */
    public function prefs_save($args)
    {
        $dont_override = (array) $this->plugin->rc->config->get('dont_override');
        $keys = array('driver_webdav_url', 'driver_webdav_prefix', 'driver_webdav_username', 'driver_webdav_password');

        foreach ($keys as $key) {
            if (in_array($key, $dont_override)) {
                continue;
            }
            $args['prefs'][$key] = rcube_utils::get_input_value('_' . $key, rcube_utils::INPUT_POST);
        }

        // Invalidate the folder cache so stale entries don't persist after a server change.
        unset($_SESSION[roundav::SESSION_FOLDERS_LIST_ID]);

        return $args;
    }

    /**
     * User interface initialization
     */
    public function ui($plugin)
    {
        $plugin->add_texts('localization/');

        // set templates of Files UI and widgets
        if ($plugin->rc->task == 'mail') {
            if ($plugin->rc->action == 'compose') {
                $template = 'compose_plugin';
            }
            else if (in_array($plugin->rc->action, array('show', 'preview', 'get'))) {
                $template = 'message_plugin';

                if ($plugin->rc->action == 'get') {
                    // add "Save as" button into attachment toolbar
                    $plugin->add_button(array(
                        'id'         => 'saveas',
                        'name'       => 'saveas',
                        'type'       => 'link',
                        'onclick'    => 'roundav_directory_selector_dialog()',
                        'class'      => 'button buttonPas saveas',
                        'classact'   => 'button saveas',
                        'label'      => 'roundav.save',
                        'title'      => 'roundav.saveto',
                        ), 'toolbar');
                }
                else {
                    // add "Save as" button into attachment menu
                    $plugin->add_button(array(
                        'id'         => 'attachmenusaveas',
                        'name'       => 'attachmenusaveas',
                        'type'       => 'link',
                        'wrapper'    => 'li',
                        'onclick'    => 'return false',
                        'class'      => 'icon active saveas',
                        'classact'   => 'icon active saveas',
                        'innerclass' => 'icon active saveas',
                        'label'      => 'roundav.saveto',
                        ), 'attachmentmenu');
                }
            }

            $plugin->add_label('save', 'cancel', 'saveto',
                'saveall', 'fromcloud', 'attachsel', 'selectfiles', 'attaching',
                'collection_audio', 'collection_video', 'collection_image', 'collection_document',
                'folderauthtitle', 'authenticating',
                'refreshfolderslist', 'createsubfolder'
            );
        }

        $plugin->include_stylesheet($plugin->local_skin_path().'/style.css');

        if (!empty($template)) {
            $plugin->include_script('roundav_api.js');
            $plugin->include_script('roundav.js');

            // register template objects for dialogs (and main interface)
            $plugin->rc->output->add_handlers(array(
                'folder-create-form' => array($this, 'folder_create_form'),
                'folder-edit-form'   => array($this, 'folder_edit_form'),
                'folder-mount-form'  => array($this, 'folder_mount_form'),
                'folder-auth-options'=> array($this, 'folder_auth_options'),
                'file-search-form'   => array($this, 'file_search_form'),
                'file-edit-form'     => array($this, 'file_edit_form'),
                'filelist'           => array($this, 'file_list'),
                'filequotadisplay'   => array($this, 'quota_display'),
            ));

            if ($plugin->rc->task != 'roundav') {
                // add dialog content at the end of page body
                $plugin->rc->output->add_footer(
                    $plugin->rc->output->parse('roundav.' . $template, false, false));
            }
        }
    }

    /**
     * Template object for folder creation form
     */
    public function folder_create_form($attrib)
    {
        $attrib['name'] = 'folder-create-form';
        if (empty($attrib['id'])) {
            $attrib['id'] = 'folder-create-form';
        }

        $input_name    = new html_inputfield(array('id' => 'folder-name', 'name' => 'name', 'size' => 30));
        // .pretty-select prevents Roundcube's elastic skin bootstrap_style() from
        // converting this select to a Bootstrap popover dropdown, which breaks when
        // the dialog content is moved into the parent window's DOM (framed context).
        $select_parent = new html_select(array('id' => 'folder-parent', 'name' => 'parent', 'class' => 'pretty-select'));
        $table         = new html_table(array('cols' => 2, 'class' => 'propform'));

        $table->add('title', html::label('folder-name', rcube::Q($this->plugin->gettext('foldername'))));
        $table->add(null, $input_name->show());
        $table->add('title', html::label('folder-parent', rcube::Q($this->plugin->gettext('folderinside'))));
        $table->add(null, $select_parent->show());

        $out = $table->show();

        // add form tag around text field
        if (empty($attrib['form'])) {
            $out = $this->plugin->rc->output->form_tag($attrib, $out);
        }

        $this->plugin->add_label('foldercreating', 'foldercreatenotice', 'create', 'foldercreate', 'cancel');
        $this->plugin->rc->output->add_gui_object('folder-create-form', $attrib['id']);

        return $out;
    }

    /**
     * Template object for folder editing form
     */
    public function folder_edit_form($attrib)
    {
        $attrib['name'] = 'folder-edit-form';
        if (empty($attrib['id'])) {
            $attrib['id'] = 'folder-edit-form';
        }

        $input_name    = new html_inputfield(array('id' => 'folder-edit-name', 'name' => 'name', 'size' => 30));
        $select_parent = new html_select(array('id' => 'folder-edit-parent', 'name' => 'parent', 'class' => 'pretty-select'));
        $table         = new html_table(array('cols' => 2, 'class' => 'propform'));

        $table->add('title', html::label('folder-name', rcube::Q($this->plugin->gettext('foldername'))));
        $table->add(null, $input_name->show());
        $table->add('title', html::label('folder-parent', rcube::Q($this->plugin->gettext('folderinside'))));
        $table->add(null, $select_parent->show());

        $out = $table->show();

        // add form tag around text field
        if (empty($attrib['form'])) {
            $out = $this->plugin->rc->output->form_tag($attrib, $out);
        }

        $this->plugin->add_label('folderupdating', 'folderupdatenotice', 'save', 'folderedit', 'cancel');
        $this->plugin->rc->output->add_gui_object('folder-edit-form', $attrib['id']);

        return $out;
    }

    /**
     * Template object for folder mounting form
     */
    public function folder_mount_form($attrib)
    {
        $sources = $this->plugin->rc->output->get_env('external_sources');

        if (empty($sources) || !is_array($sources)) {
            return '';
        }

        $attrib['name'] = 'folder-mount-form';
        if (empty($attrib['id'])) {
            $attrib['id'] = 'folder-mount-form';
        }

        // build form content
        $table        = new html_table(array('cols' => 2, 'class' => 'propform'));
        $input_name   = new html_inputfield(array('id' => 'folder-mount-name', 'name' => 'name', 'size' => 30));
        $input_driver = new html_radiobutton(array('name' => 'driver', 'size' => 30));

        $table->add('title', html::label('folder-mount-name', rcube::Q($this->plugin->gettext('name'))));
        $table->add(null, $input_name->show());

        foreach ($sources as $key => $source) {
            $id    = 'source-' . $key;
            $form  = new html_table(array('cols' => 2, 'class' => 'propform driverform'));

            foreach ((array) $source['form'] as $idx => $label) {
                $iid = $id . '-' . $idx;
                $type  = stripos($idx, 'pass') !== false ? 'html_passwordfield' : 'html_inputfield';
                $input = new $type(array('size' => 30));

                $form->add('title', html::label($iid, rcube::Q($label)));
                $form->add(null, $input->show('', array(
                        'id'   => $iid,
                        'name' => $key . '[' . $idx . ']'
                )));
            }

            $row = $input_driver->show(null, array('value' => $key))
                . html::img(array('src' => $source['image'], 'alt' => $key, 'title' => $source['name']))
                . html::div(null, html::span('name', rcube::Q($source['name']))
                    . html::br()
                    . html::span('description', rcube::Q($source['description']))
                    . $form->show()
                );

            $table->add(array('id' => $id, 'colspan' => 2, 'class' => 'source'), $row);
        }

        $out = $table->show() . $this->folder_auth_options(array('suffix' => '-form'));

        // add form tag around text field
        if (empty($attrib['form'])) {
            $out = $this->plugin->rc->output->form_tag($attrib, $out);
        }

        $this->plugin->add_label('foldermounting', 'foldermountnotice', 'foldermount',
            'save', 'cancel', 'folderauthtitle', 'authenticating'
        );
        $this->plugin->rc->output->add_gui_object('folder-mount-form', $attrib['id']);

        return $out;
    }

    /**
     * Template object for folder authentication options
     */
    public function folder_auth_options($attrib)
    {
        $suffix = $attrib['suffix'] ?? '';
        $checkbox = new html_checkbox(array(
            'name'  => 'store_passwords',
            'value' => '1',
            'id'    => 'auth-pass-checkbox' . $suffix,
        ));

        return html::div('auth-options', $checkbox->show(). '&nbsp;'
            . html::label('auth-pass-checkbox' . $suffix, $this->plugin->gettext('storepasswords'))
            . html::span('description', $this->plugin->gettext('storepasswordsdesc'))
        );
    }

    /**
     * Template object for file_edit form
     */
    public function file_edit_form($attrib)
    {
        $attrib['name'] = 'file-edit-form';
        if (empty($attrib['id'])) {
            $attrib['id'] = 'file-edit-form';
        }

        $input_name = new html_inputfield(array('id' => 'file-name', 'name' => 'name', 'size' => 30));
        $table      = new html_table(array('cols' => 2, 'class' => 'propform'));

        $table->add('title', html::label('file-name', rcube::Q($this->plugin->gettext('filename'))));
        $table->add(null, $input_name->show());

        $out = $table->show();

        // add form tag around text field
        if (empty($attrib['form'])) {
            $out = $this->plugin->rc->output->form_tag($attrib, $out);
        }

        $this->plugin->add_label('save', 'cancel', 'fileupdating', 'fileedit');
        $this->plugin->rc->output->add_gui_object('file-edit-form', $attrib['id']);

        return $out;
    }

    /**
     * Template object for file search form in "From cloud" dialog
     */
    public function file_search_form($attrib)
    {
        $attrib['name'] = '_q';
        $attrib['placeholder'] = 'Search';

        if (empty($attrib['id'])) {
            $attrib['id'] = 'filesearchbox';
        }
        if (isset($attrib['type']) && $attrib['type'] == 'search' && !$this->plugin->rc->output->browser->khtml) {
            unset($attrib['type'], $attrib['results']);
        }

        $input_q = new html_inputfield($attrib);
        $out = $input_q->show();

        // add some labels to client
        $this->plugin->add_label('searching');
        $this->plugin->rc->output->add_gui_object('filesearchbox', $attrib['id']);

        // add form tag around text field
        if (empty($attrib['form'])) {
            $out = $this->plugin->rc->output->form_tag(array(
                'action'   => '?_task=files',
                'name'     => "filesearchform",
                'onsubmit' => rcmail_output::JS_OBJECT_NAME . ".command('files-search'); return false",
            ), $out);
        }

        return $out;
    }

    /**
     * Template object for files list
     */
    public function file_list($attrib)
    {
        // define list of cols to be displayed based on parameter or config
        if (empty($attrib['columns'])) {
            $list_cols     = $this->plugin->rc->config->get('roundav_list_cols');
            $dont_override = $this->plugin->rc->config->get('dont_override');
            $a_show_cols = is_array($list_cols) ? $list_cols : array('name');
            $this->plugin->rc->output->set_env('col_movable', !in_array('roundav_list_cols', (array)$dont_override));
        }
        else {
            $a_show_cols = preg_split('/[\s,;]+/', strip_quotes($attrib['columns']));
        }

        // make sure 'name' and 'options' column is present
        if (!in_array('name', $a_show_cols)) {
            array_unshift($a_show_cols, 'name');
        }
        if (!in_array('options', $a_show_cols)) {
            array_unshift($a_show_cols, 'options');
        }

        $attrib['columns'] = $a_show_cols;

        // save some variables for use in ajax list
        $_SESSION['roundav_list_attrib'] = $attrib;

        // For list in dialog(s) remove all option-like columns
        if ($this->plugin->rc->task != 'roundav') {
            $a_show_cols = array_intersect($a_show_cols, $this->sort_cols);
        }

        // set default sort col/order to session
        if (!isset($_SESSION['roundav_sort_col']))
            $_SESSION['roundav_sort_col'] = $this->plugin->rc->config->get('roundav_sort_col') ?: 'name';
        if (!isset($_SESSION['roundav_sort_order']))
            $_SESSION['roundav_sort_order'] = strtoupper($this->plugin->rc->config->get('roundav_sort_order') ?: 'asc');

        // set client env
        $this->plugin->rc->output->add_gui_object('filelist', $attrib['id']);
        $this->plugin->rc->output->set_env('sort_col', $_SESSION['roundav_sort_col']);
        $this->plugin->rc->output->set_env('sort_order', $_SESSION['roundav_sort_order']);
        $this->plugin->rc->output->set_env('coltypes', $a_show_cols);
        $this->plugin->rc->output->set_env('search_threads', $this->plugin->rc->config->get('roundav_search_threads'));

        $this->plugin->rc->output->include_script('list.js');

        // attach css rules for mimetype icons
        $this->plugin->include_stylesheet($this->plugin->local_skin_path() . '/mimetypes/style.css');

        $thead = '';
        foreach ($this->file_list_head($attrib, $a_show_cols) as $cell) {
            $thead .= html::tag('th', array('class' => $cell['className'], 'id' => $cell['id']), $cell['html']);
        }

        return html::tag('table', $attrib,
            html::tag('thead', null, html::tag('tr', null, $thead)) . html::tag('tbody', null, ''),
            array('style', 'class', 'id', 'cellpadding', 'cellspacing', 'border', 'summary'));
    }

    /**
     * Creates <THEAD> for message list table
     */
    protected function file_list_head($attrib, $a_show_cols)
    {
        $skin_path = $this->plugin->local_skin_path();

        // check to see if we have some settings for sorting
        $sort_col   = $_SESSION['roundav_sort_col'];
        $sort_order = $_SESSION['roundav_sort_order'];

        $dont_override  = (array)$this->plugin->rc->config->get('dont_override');
        $disabled_sort  = in_array('message_sort_col', $dont_override);
        $disabled_order = in_array('message_sort_order', $dont_override);

        $this->plugin->rc->output->set_env('disabled_sort_col', $disabled_sort);
        $this->plugin->rc->output->set_env('disabled_sort_order', $disabled_order);

        // define sortable columns
        if ($disabled_sort)
            $a_sort_cols = $sort_col && !$disabled_order ? array($sort_col) : array();
        else
            $a_sort_cols = $this->sort_cols;

        if (!empty($attrib['optionsmenuicon'])) {
            $onclick = 'return ' . rcmail_output::JS_OBJECT_NAME . ".command('menu-open', 'filelistmenu', this, event)";
            $inner   = $this->plugin->rc->gettext('listoptions');

            if (is_string($attrib['optionsmenuicon']) && $attrib['optionsmenuicon'] != 'true') {
                $inner = html::img(array('src' => $skin_path . $attrib['optionsmenuicon'], 'alt' => $this->plugin->rc->gettext('listoptions')));
            }

            $list_menu = html::a(array(
                'href'     => '#list-options',
                'onclick'  => $onclick,
                'class'    => 'listmenu',
                'id'       => 'listmenulink',
                'title'    => $this->plugin->rc->gettext('listoptions'),
                'tabindex' => '0',
            ), $inner);
        }
        else {
            $list_menu = '';
        }

        $cells = array();

        foreach ($a_show_cols as $col) {
            // get column name
            switch ($col) {
                case 'options':
                    $col_name = $list_menu;
                    break;
                default:
                    $col_name = rcube::Q($this->plugin->gettext($col));
            }

            // make sort links
            if (in_array($col, $a_sort_cols)) {
                $col_name = html::a(array(
                        'href'    => "#sort",
                        'onclick' => 'return ' . rcmail_output::JS_OBJECT_NAME . ".command('files-sort','$col',this)",
                        'title'   => $this->plugin->gettext('sortby')
                    ), $col_name);
            }
            else if ($col_name[0] != '<')
                $col_name = '<span class="' . $col .'">' . $col_name . '</span>';

            $sort_class = $col == $sort_col && !$disabled_order ? " sorted$sort_order" : '';
            $class_name = $col.$sort_class;

            // put it all together
            $cells[] = array('className' => $class_name, 'id' => "rcm$col", 'html' => $col_name);
        }

        return $cells;
    }

    /**
     * Update files list object
     */
    protected function file_list_update($prefs)
    {
        $attrib = $_SESSION['roundav_list_attrib'];

        if (!empty($prefs['roundav_list_cols'])) {
            $attrib['columns'] = $prefs['roundav_list_cols'];
            $_SESSION['roundav_list_attrib'] = $attrib;
        }

        $a_show_cols = $attrib['columns'];
        $head        = '';

        foreach ($this->file_list_head($attrib, $a_show_cols) as $cell) {
            $head .= html::tag('td', array('class' => $cell['className'], 'id' => $cell['id']), $cell['html']);
        }

        $head = html::tag('tr', null, $head);

        $this->plugin->rc->output->set_env('coltypes', $a_show_cols);
        $this->plugin->rc->output->command('files_list_update', $head);
    }

    /**
     * Template object for quota display
     */
    public function quota_display($attrib)
    {
        if (!$attrib['id']) {
            $attrib['id'] = 'rcmquotadisplay';
        }

        $quota_type = !empty($attrib['display']) ? $attrib['display'] : 'text';

        $this->plugin->rc->output->add_gui_object('quotadisplay', $attrib['id']);
        $this->plugin->rc->output->set_env('quota_type', $quota_type);

        // get quota
        $quota = array("used" => 0, "total" => 1024);

        $quota = rcube_output::json_serialize($quota);

        $this->plugin->rc->output->add_script(rcmail_output::JS_OBJECT_NAME . ".files_set_quota($quota);", 'docready');

        return html::span($attrib, '');
    }

    /**
     * Handler for preferences save action
     */
    public function action_prefs($plugin)
    {
        $plugin->add_texts('localization/');

        $dont_override = (array) $plugin->rc->config->get('dont_override');
        $prefs = array();
        $opts  = array(
            'roundav_sort_col' => true,
            'roundav_sort_order' => true,
            'roundav_list_cols' => false,
        );

        foreach ($opts as $o => $sess) {
            if (isset($_POST[$o]) && !in_array($o, $dont_override)) {
                $prefs[$o] = rcube_utils::get_input_value($o, rcube_utils::INPUT_POST);
                if ($sess) {
                    $_SESSION[$o] = $prefs[$o];
                }

                if ($o == 'roundav_list_cols') {
                    $update_list = true;
                }
            }
        }

        // save preference values
        if (!empty($prefs)) {
            $plugin->rc->user->save_prefs($prefs);
        }

        if (!empty($update_list)) {
            $this->file_list_update($prefs);
        }

        $plugin->rc->output->send();
    }

    /**
     * Handler for "save all attachments into cloud" action
     */
    public function action_save_file($plugin)
    {
        $plugin->add_texts('localization/');

        $uid    = rcube_utils::get_input_value('uid', rcube_utils::INPUT_POST);
        $dest   = rcube_utils::get_input_value('dest', rcube_utils::INPUT_POST);
        $id     = rcube_utils::get_input_value('id', rcube_utils::INPUT_POST);
        $name   = rcube_utils::get_input_value('name', rcube_utils::INPUT_POST);

        $temp_dir = unslashify($plugin->rc->config->get('temp_dir'));
        $message  = new rcube_message($uid);
        $files    = array();
        $errors   = array();
        $attachments = array();

        foreach ($message->attachments as $attach_prop) {
            if (empty($id) || $id == $attach_prop->mime_id) {
                $filename = !is_null($name) && strlen($name) ? $name : $plugin->get_attachment_name($attach_prop, true);
                $attachments[$filename] = $attach_prop;
            }
        }

        // @TODO: handle error
        // @TODO: implement file upload using file URI instead of body upload

        if (!is_null($dest)) {
            $filesPrefix = $plugin->gettext('files');
            $dest = ltrim(substr($dest, strlen($filesPrefix)), '/');
        }

        foreach ($attachments as $attach_name => $attach_prop) {
            $path = tempnam($temp_dir, 'rcmAttmnt');

            // save attachment to file
            if ($fp = fopen($path, 'w+')) {
                $message->get_part_body($attach_prop->mime_id, false, 0, $fp);
            }
            else {
                $errors[] = true;
                rcube::raise_error(array(
                    'code' => 500, 'type' => 'php', 'line' => __LINE__, 'file' => __FILE__,
                    'message' => "Unable to save attachment into file $path"),
                    true, false);
                continue;
            }

            fclose($fp);

            // send request to the API
            try {
                $this->filesystem->write($dest .  '/' . $attach_name, file_get_contents($path));
                $files[] = $attach_name;
            }
            catch (Exception $e) {
                unlink($path);
                $errors[] = $e->getMessage();
                rcube::raise_error(array(
                    'code' => 500, 'type' => 'php', 'line' => __LINE__, 'file' => __FILE__,
                    'message' => $e->getMessage()),
                    true, false);
                continue;
            }

            // clean up
            unlink($path);
        }

        if ($count = count($files)) {
            $msg = $plugin->gettext(array('name' => 'saveallnotice', 'vars' => array('n' => $count)));
            // Append destination folder so the user knows where the file(s) were saved
            $dest_display = strlen($dest) ? $dest : '/';
            $msg .= ' → ' . $dest_display;
            $plugin->rc->output->show_message($msg, 'confirmation');
        }
        if ($count = count($errors)) {
            $msg = $plugin->gettext(array('name' => 'saveallerror', 'vars' => array('n' => $count)));
            $plugin->rc->output->show_message($msg, 'error');
        }

        // @TODO: update quota indicator, make this optional in case files aren't stored in IMAP

        $plugin->rc->output->send();
    }

    /**
     * Handler for "add attachments from the cloud" action
     */
    public function action_attach_file($plugin)
    {
        $plugin->add_texts('localization/');

        $files      = rcube_utils::get_input_value('files', rcube_utils::INPUT_POST);
        $uploadid   = rcube_utils::get_input_value('uploadid', rcube_utils::INPUT_POST);
        $COMPOSE_ID = rcube_utils::get_input_value('id', rcube_utils::INPUT_POST);
        $COMPOSE    = null;
        $errors     = array();

        if ($COMPOSE_ID && $_SESSION['compose_data_'.$COMPOSE_ID]) {
            $COMPOSE =& $_SESSION['compose_data_'.$COMPOSE_ID];
        }

        if (!$COMPOSE) {
            die("Invalid session var!");
        }

        // clear all stored output properties (like scripts and env vars)
        $plugin->rc->output->reset();

        $temp_dir = unslashify($plugin->rc->config->get('temp_dir'));

        // download files from the API and attach them
        foreach ($files as $file) {
            // decode filename
            $file = urldecode($file);
            $filesPrefix = $plugin->gettext('files');
            $file = ltrim(substr($file, strlen($filesPrefix)), '/');

            // set location of downloaded file
            $path = tempnam($temp_dir, 'rcmAttmnt');

            try {
                // save attachment to file
                if ($fp = fopen($path, 'w+')) {
                    fwrite($fp, $this->filesystem->read($file));
                }
                else {
                    $errors[] = "Can't open temporary file";
                    rcube::raise_error([
                            'code' => 500, 'type' => 'php', 'line' => __LINE__, 'file' => __FILE__,
                            'message' => "Can't open temporary file"
                        ],
                        true,
                        false
                    );
                    continue;
                }
                fclose($fp);
            }
            catch (Exception $e) {
                $errors[] = $e->getMessage();
                rcube::raise_error([
                        'code' => 500, 'type' => 'php', 'line' => __LINE__, 'file' => __FILE__,
                        'message' => $e->getMessage()
                    ],
                    true,
                    false
                );
                continue;
            }

            $attachment = array(
                'path' => $path,
                'size' => $this->filesystem->fileSize($file),
                'name' => $this->get_filename_from_path($file),
                'mimetype' => $this->filesystem->mimeType($file),
                'group' => $COMPOSE_ID,
            );

            if ($plugin->rc->insert_uploaded_file($attachment, 'attachment_save')) {
                $id = $attachment['id'];

                if ((isset($COMPOSE['deleteicon']) && $icon = $COMPOSE['deleteicon']) && is_file($icon)) {
                    $button = html::img(array(
                        'src' => $icon,
                        'alt' => $plugin->rc->gettext('delete')
                    ));
                }
                else {
                    $button = rcube::Q($plugin->rc->gettext('delete'));
                }

                $content = html::a(array(
                    'href' => "#delete",
                    'onclick' => sprintf("return %s.command('remove-attachment','rcmfile%s', this)", rcmail_output::JS_OBJECT_NAME, $id),
                    'title' => $plugin->rc->gettext('delete'),
                    'class' => 'delete',
                ), $button);

                $content .= rcube::Q($attachment['name']);

                $plugin->rc->output->command('add2attachment_list', "rcmfile$id", array(
                    'html'      => $content,
                    'name'      => $attachment['name'],
                    'mimetype'  => $attachment['mimetype'],
                    'classname' => rcube_utils::file2class($attachment['mimetype'], $attachment['name']),
                    'complete'  => true), $uploadid);
            }
            else if ($attachment['error']) {
                $errors[] = $attachment['error'];
            }
            else {
                $errors[] = $plugin->gettext('attacherror');
            }
        }

        if (!empty($errors)) {
            $plugin->rc->output->command('display_message', $plugin->gettext('attacherror'), 'error');
            $plugin->rc->output->command('remove_from_attachment_list', $uploadid);
        }

        // send html page with JS calls as response
        $plugin->rc->output->command('auto_save_start', false);
        $plugin->rc->output->send();
    }

    /**
     * Handler for "folders list" function
     *
     * Two modes:
     *  - default (lazy): returns a subtree bounded to `depth` levels (default 3) below the
     *    `folder` base (default root). Boundary folders at the deepest level get an optimistic
     *    toggle so the client can lazily request the next batch on expand.
     *  - flat=true: returns the complete recursive list of folder paths (strings). Only used by
     *    the "search all folders" / collection features, which must scan the whole tree.
     */
    public function action_folder_list($plugin)
    {
        $plugin->add_texts('localization/');

        $result = array(
            'status' => 'OK',
            'result' => array(),
            'req_id' => rcube_utils::get_input_value('req_id', rcube_utils::INPUT_GET),
        );

        $this->require_filesystem($result);

        $filesPrefix   = $plugin->gettext('files');
        $flat          = rcube_utils::get_input_value('flat', rcube_utils::INPUT_GET) === "true";
        $force_refresh = rcube_utils::get_input_value('force_refresh', rcube_utils::INPUT_GET) === "true";

        if ($force_refresh) {
            // Drop every cached subtree (and the flat list).
            unset($_SESSION[$plugin::SESSION_FOLDERS_LIST_ID]);
        }

        // Full recursive list (search / collections).
        if ($flat) {
            try {
                $result['result'] = array(
                    'flat'    => true,
                    'folders' => $this->flat_folder_list($plugin, $filesPrefix),
                );
            }
            catch (Exception $e) {
                $result['status'] = 'NOK';
                $result['reason'] = "Can't list folders: “" . $e->getMessage() . "”";
            }
            echo json_encode($result);
            exit();
        }

        // Bounded, lazy subtree listing.
        $depth = (int) rcube_utils::get_input_value('depth', rcube_utils::INPUT_GET);
        if ($depth <= 0) {
            $depth = 2;
        }

        $folderParam = rcube_utils::get_input_value('folder', rcube_utils::INPUT_GET);
        if ($folderParam === null || $folderParam === '') {
            $folderParam = $filesPrefix;
        }

        // Translate display path "Files/a/b" -> WebDAV path. Strip only the leading prefix
        // segment (not a blanket str_replace) so a folder whose own name contains "Files"
        // (e.g. "Files/2024/Files_backup") isn't corrupted.
        $baseFsPath = $folderParam === $filesPrefix
            ? '/'
            : '/' . ltrim(substr($folderParam, strlen($filesPrefix) + 1), '/');
        $baseDepth  = $folderParam === $filesPrefix ? 0 : count(explode('/', $folderParam)) - 1;
        // Cache key includes depth so a subtree cached at one depth is never served back for a
        // request asking for a different depth, and a version so sessions predating a change
        // in shape/ordering never serve stale data.
        $baseKey    = $folderParam . '@' . $depth . '@v' . self::FOLDER_CACHE_VERSION;

        // Always present, even on error, so the client can identify which folder a response
        // (success or failure) belongs to.
        $result['result'] = array(
            'base'    => $folderParam,
            'depth'   => $depth,
            'folders' => array(),
        );

        try {
            $subtree = $_SESSION[$plugin::SESSION_FOLDERS_LIST_ID][$baseKey] ?? null;

            if ($subtree === null) {
                $subtree = $this->list_dirs_bounded($baseFsPath, $baseDepth, $depth, $filesPrefix);

                // From the root, include the "Files" node itself (matches the old array_unshift).
                if ($folderParam === $filesPrefix) {
                    array_unshift($subtree, array(
                        'path'         => $filesPrefix,
                        'depth'        => 0,
                        'has_children' => count($subtree) > 0,
                        'boundary'     => false,
                    ));
                }

                $_SESSION[$plugin::SESSION_FOLDERS_LIST_ID][$baseKey] = $subtree;
            }

            $result['result']['folders'] = $subtree;
        }
        catch (Exception $e) {
            $result['status'] = 'NOK';
            $result['reason'] = "Can't list folders: “" . $e->getMessage() . "”";
        }
        echo json_encode($result);
        exit();
    }

    /**
     * Full recursive list of directory display-paths (legacy shape), cached per session.
     * Used only for search / collection fan-out.
     *
     * @return string[]
     */
    private function flat_folder_list($plugin, $filesPrefix)
    {
        $cacheKey = '__flat__@v' . self::FOLDER_CACHE_VERSION;

        if (isset($_SESSION[$plugin::SESSION_FOLDERS_LIST_ID][$cacheKey])) {
            return $_SESSION[$plugin::SESSION_FOLDERS_LIST_ID][$cacheKey];
        }

        $folders = $this->filesystem->listContents('/', true)
            ->filter(fn (StorageAttributes $attributes) => $attributes->isDir())
            ->map(fn (StorageAttributes $attributes) => $filesPrefix . '/' . $attributes->path())
            ->toArray();

        $folders = $this->sort_paths($folders);

        // Root stays first. Every other entry is "<prefix>/…" so it would sort first anyway,
        // but unshifting after the sort makes that independent of the comparator.
        array_unshift($folders, $filesPrefix);

        $_SESSION[$plugin::SESSION_FOLDERS_LIST_ID][$cacheKey] = $folders;

        return $folders;
    }

    /**
     * Bounded breadth-first directory listing: one non-recursive PROPFIND per directory, down to
     * `$depthLimit` levels below the base. Returns entries ordered parents-before-children.
     *
     * @param string $baseFsPath  WebDAV base path (as produced by str_replace of the display prefix)
     * @param int    $baseDepth   absolute display-depth of the base ("Files" = 0)
     * @param int    $depthLimit  number of levels to descend below the base
     * @param string $filesPrefix localized "Files" display prefix
     * @return array[] each: ['path' => display path, 'depth' => int, 'has_children' => bool, 'boundary' => bool]
     */
    private function list_dirs_bounded($baseFsPath, $baseDepth, $depthLimit, $filesPrefix)
    {
        $entries = array(); // keyed by display path (insertion order = parents first)

        // Queue items: [fsPath, level] where level is relative to the base (1 = immediate child).
        $queue = array(array($baseFsPath, 1));

        while (!empty($queue)) {
            list($dir, $level) = array_shift($queue);
            $isBoundary = $level >= $depthLimit;

            $children = $this->filesystem->listContents($dir, false)
                ->filter(fn (StorageAttributes $attributes) => $attributes->isDir());

            // listContents() already returns decoded paths: decoding again would turn "+" into
            // a space and "%41" into "A".
            $decoded = array();
            foreach ($children as $child) {
                $decoded[] = $child->path();
            }

            // Sorting each batch is enough: the BFS is level-order (so parents still come
            // before children) and the client appends every row into its own parent's
            // <ul.subfolders>, so only the order *within* one listContents() call is visible.
            $ranks = $this->name_ranks(array_map('basename', $decoded));
            usort($decoded, fn ($a, $b) => $ranks[basename($a)] <=> $ranks[basename($b)]);

            foreach ($decoded as $path) {
                $displayPath = $filesPrefix . '/' . $path;

                $entries[$displayPath] = array(
                    'path'         => $displayPath,
                    'depth'        => $baseDepth + $level,
                    'has_children' => $isBoundary, // optimistic for boundary; corrected below otherwise
                    'boundary'     => $isBoundary,
                );

                if (!$isBoundary) {
                    $queue[] = array($path, $level + 1);
                }
            }
        }

        // Interior nodes were PROPFIND'd, so we know their child status exactly: a node has children
        // iff some other discovered entry is its direct child. Boundary nodes keep the optimistic flag.
        foreach ($entries as $path => $entry) {
            if ($entry['boundary']) {
                continue;
            }
            $entries[$path]['has_children'] = false;
        }
        foreach ($entries as $path => $entry) {
            $slash = strrpos($path, '/');
            if ($slash === false) {
                continue;
            }
            $parent = substr($path, 0, $slash);
            if (isset($entries[$parent])) {
                $entries[$parent]['has_children'] = true;
            }
        }

        return array_values($entries);
    }

    /**
     * Handler for "file list" function
     */
    public function action_file_list($plugin)
    {
        $plugin->add_texts('localization/');

        $result = array(
            'status' => 'OK',
            'result' => array(),
            'req_id' => rcube_utils::get_input_value('req_id', rcube_utils::INPUT_GET),
        );

        $this->require_filesystem($result);

        $searchKeyword = '';
        $searchType = '';

        $search = rcube_utils::get_input_value('search', rcube_utils::INPUT_GET);
        if (!empty($search)) {
            if (is_array($search)) {
                $searchKeyword = strtolower($search['name'] ?? '');
                $searchType = strtolower($search['class'] ?? '');
            } else {
                $searchKeyword = strtolower($search);
            }
        }

        try {
            $filesPrefix = $plugin->gettext('files');
            $folder = str_replace($filesPrefix, '/', rcube_utils::get_input_value('folder', rcube_utils::INPUT_GET));
            $files = [];

            $fsFiles = $this->filesystem->listContents($folder, false)
                ->filter(fn (StorageAttributes $attributes) => $attributes->isFile());

            if (!empty($searchKeyword) || !empty($searchType)) {
                $fsFiles = $fsFiles->filter(function (StorageAttributes $attributes) use ($searchKeyword, $searchType) {
                    if (!$attributes->isFile()) {
                        return false;
                    }

                    if (!empty($searchKeyword)) {
                        $name = strtolower(basename($attributes->path()));

                        if (strpos($name, $searchKeyword) === false)
                        {
                            return false;
                        }
                    }

                    if (!empty($searchType)) {
                        $fileType = explode('/', $attributes['mimeType'] ?? '')[0];
                        if ($searchType !== $fileType)
                        {
                            return false;
                        }
                    }

                    return true;
                });
            }

            foreach ($fsFiles as $fsfile) {
                // The key is the only encoded value: it is decoded back in action_attach_file()
                // and by $_GET in action_file_get(). listContents() paths are already decoded.
                $key = urlencode($filesPrefix. '/'. $fsfile->path());
                $files[$key] = [
                    'name' => basename($fsfile->path()),
                    'type' => $fsfile['mimeType'],
                    'size' => $fsfile['fileSize'],
                    'mtime' => $fsfile['lastModified'],
                ];
            }

            $sort    = rcube_utils::get_input_value('sort', rcube_utils::INPUT_GET);
            $reverse = rcube_utils::get_input_value('reverse', rcube_utils::INPUT_GET) === 'true';

            // Unknown / missing column: fall back to the persisted preference, then to 'name'.
            if (!in_array($sort, $this->sort_cols, true)) {
                $sort = $_SESSION['roundav_sort_col'] ?? 'name';
                if (!in_array($sort, $this->sort_cols, true)) {
                    $sort = 'name';
                }
                $reverse = strtoupper($_SESSION['roundav_sort_order'] ?? 'ASC') === 'DESC';
            }

            $ranks = $this->name_ranks(array_column($files, 'name'));

            // uasort: keys must survive, they are the row ids used by file_list_row() and by
            // file_list_response's data.filename (roundav.js).
            uasort($files, function ($a, $b) use ($sort, $reverse, $ranks) {
                if ($sort === 'name') {
                    $r = $ranks[$a['name']] <=> $ranks[$b['name']];
                    return $reverse ? -$r : $r;
                }

                // 'size' | 'mtime' are both ?int and are never formatted server-side,
                // so a plain numeric compare is correct. null => 0.
                $r = ($a[$sort] ?? 0) <=> ($b[$sort] ?? 0);

                // Equal sizes / timestamps are common; tie-break by name, always ascending.
                if ($r === 0) {
                    return $ranks[$a['name']] <=> $ranks[$b['name']];
                }

                return $reverse ? -$r : $r;
            });

            $result['result'] = $files;
        }
        catch (Exception $e) {
            $result['status'] = 'NOK';
            $result['reason'] = "Can't list files: “" . $e->getMessage() . "”";
        }
        echo json_encode($result);
        exit();
    }

    /**
     * Handler for "folder create" function
     */
    public function action_folder_create($plugin)
    {
        $plugin->add_texts('localization/');

        $result = array(
            'status' => 'OK',
            'req_id' => rcube_utils::get_input_value('req_id', rcube_utils::INPUT_GET),
        );

        $this->require_filesystem($result);

        try {
            $folder = rcube_utils::get_input_value('folder', rcube_utils::INPUT_POST);

            $filesPrefix = $plugin->gettext('files');

            // Strip localised "Files/" prefix to get WebDAV-relative path.
            // str_replace would produce a leading slash ("/FOLD/...") — use substr instead.
            $webdav_path = ltrim(substr($folder, strlen($filesPrefix)), '/');

            $this->filesystem->createDirectory($webdav_path);

            unset($_SESSION[$plugin::SESSION_FOLDERS_LIST_ID]);
        }
        catch (Exception $e) {
            $result['status'] = 'NOK';
            $result['reason'] = "Can't create folder: “" . $e->getMessage() . "”";
        }
        echo json_encode($result);
        exit();
    }

    /**
     * Handler for "file get" function
     */
    public function action_file_get($plugin)
    {
        try {
            $filesPrefix = $plugin->gettext('files');
            $file = ltrim(substr(rcube_utils::get_input_value('file', rcube_utils::INPUT_GET), strlen($filesPrefix)), '/');

            header('Content-Type: ' . $this->filesystem->mimeType($file));
            header('Content-disposition: attachment; filename=' . $this->get_filename_from_path($file));
            header('Content-Length: ' . $this->filesystem->fileSize($file));
            echo $this->filesystem->read($file);
        }
        catch (Exception $e) {}

        exit();
    }

    /**
     * Returns mimetypes supported by File API viewers
     */
    protected function get_mimetypes()
    {
        return array();
    }

    /**
     * Convertit le chemin en nom de fichier
     * @param string $path
     * @return string
     */
    protected function get_filename_from_path($path)
    {
        $filename = $path;
        $tmp = explode('/', $path);
        if (is_array($tmp) && count($tmp) > 0) {
            $filename = end($tmp);
        }
        return $filename;
    }
}
