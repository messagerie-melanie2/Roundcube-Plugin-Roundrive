<?php

/**
 * Roundcube Drive using flysystem for filesystem
 *
 * @version @package_version@
 * @author Thomas Payen <thomas.payen@apitech.fr>
 *
 * This plugin is inspired by kolab_files plugin
 * Use flysystem library : https://github.com/thephpleague/flysystem
 * With flysystem WebDAV adapter : https://github.com/thephpleague/flysystem-webdav
 *
 * Copyright (C) 2015 PNE Annuaire et Messagerie MEDDE/MLETR
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
 */

// Use Roundcube's main vendor autoloader when installed via Composer (no local vendor dir)
$autoload = file_exists(__DIR__.'/vendor/autoload.php')
    ? __DIR__.'/vendor/autoload.php'
    : __DIR__.'/../../vendor/autoload.php';
require_once($autoload);

require_once(__DIR__.'/lib/roundav_files_engine.php');

class roundav extends rcube_plugin
{
    public const SESSION_FOLDERS_LIST_ID = 'roundav_folders_list';

    // All tasks excluding 'login' and 'logout'
    public $task = '?(?!login|logout).*';

    public $rc;
    public $home;
    private $engine;

    public function init()
    {
        $this->rc = rcube::get_instance();

        // Do not edit the order of the lines below.
        // Everything will break for some reason.

        $this->add_hook('refresh', array($this, 'refresh'));

        $this->register_action('plugin.roundav', array($this, 'actions'));

        $this->register_task('roundav');

        $this->register_action('prefs', array($this, 'actions'));
        $this->register_action('roundav_api', array($this, 'actions'));

        $this->add_hook('startup', array($this, 'startup'));
        $this->add_hook('logout', array($this, 'onlogout'));

        if ($this->rc->task == 'settings') {
            $this->add_hook('preferences_sections_list', array($this, 'prefs_section'));
            $this->add_hook('preferences_list', array($this, 'prefs_list'));
            $this->add_hook('preferences_save', array($this, 'prefs_save'));
        }
    }

    public function refresh($args = null)
    {
        $this->load_config();
        if (!$this->engine) {
            $this->engine = new roundav_files_engine($this);
        }

        return $args;
    }

    /**
     * Startup hook handler, initializes/enables Files UI
     */
    public function startup($args)
    {
        $this->refresh();

        if ($this->rc->output->type != 'html') {
            return;
        }

        $this->engine->ui($this);

        return $args;
    }

    /**
     * Logout hook handler
     */
    public function onlogout($args)
    {
        unset($_SESSION[self::SESSION_FOLDERS_LIST_ID]);

        return $args;
    }

    public function prefs_section($args)
    {
        $this->add_texts('localization/');
        $args['list']['roundav'] = array(
            'id'      => 'roundav',
            'section' => $this->gettext('settings_section'),
        );
        return $args;
    }

    public function prefs_list($args)
    {
        if ($args['section'] != 'roundav') {
            return $args;
        }
        $this->refresh();
        return $this->engine->prefs_list($args);
    }

    public function prefs_save($args)
    {
        if ($args['section'] != 'roundav') {
            return $args;
        }
        $this->refresh();
        return $this->engine->prefs_save($args);
    }

    /**
     * Engine actions handler
     */
    public function actions()
    {
        if ($this->engine)
        {
            $rc = rcube::get_instance();
            $rcTask = $rc->task;
            $rcAction = $rc->action;

            if ($rcTask == 'roundav' && $rcAction == 'roundav_api') {
                $action = rcube_utils::get_input_value('method', rcube_utils::INPUT_GPC);
            }
            else if ($rcTask == 'roundav' && $rcAction) {
                $action = $rcAction;
            }
            else if ($rcTask != 'roundav' && $_POST['act']) {
                $action = $_POST['act'];
            }
            else {
                $action = 'index';
            }

            switch ($action)
            {
                case 'save_file';
                    $this->engine->action_save_file($this);
                    break;

                case 'attach_file':
                    $this->engine->action_attach_file($this);
                    break;

                case 'folder_list':
                    $this->engine->action_folder_list($this);
                    break;

                case 'folder_create':
                    $this->engine->action_folder_create($this);
                    break;

                case 'file_list':
                    $this->engine->action_file_list($this);
                    break;

                case 'file_get':
                    $this->engine->action_file_get($this);
                    break;

                default:
                    echo(json_encode([
                        'status' => 'NOK',
                        'reason' => 'Unknown action',
                        'req_id' => rcube_utils::get_input_value('req_id', rcube_utils::INPUT_GET),
                    ]));
            }
        }
    }

    /**
     * Return attachment filename, handle empty filename case
     *
     * @param rcube_message_part $attachment Message part
     * @param bool               $display    Convert to a description text for "special" types
     *
     * @return string Filename
     */
    public function get_attachment_name($attachment, $display)
    {
        return rcmail_action_mail_index::attachment_name($attachment, $display);
    }
}
