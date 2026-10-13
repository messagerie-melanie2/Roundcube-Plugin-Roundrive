# Roundav

This plugin is a fork of [Roundcube-Plugin-Roundrive](https://github.com/messagerie-melanie2/Roundcube-Plugin-Roundrive), itself “largely inspired by the plugin kolab_file”.

It can be used to connect to a WebDAV storage (like Nextcloud) from Roundcube to save attachments to the WebDAV storage or insert attachments from it...

License
-------

This plugin is released under the [GNU Affero General Public License Version 3](https://www.gnu.org/licenses/agpl-3.0.html).

Credits
-------

The "create a subdirectory" folder icon is ["Folder Plus"](https://www.svgrepo.com/svg/532824/folder-plus) from SVG Repo.

Install
-------

Requires Roundcube **1.7.0** or later (it relies on `rcube::insert_uploaded_file()`, added in 1.7).
Installing through Composer enforces this automatically; copying the folder by hand does not.

1. Place this plugin folder into plugins directory of Roundcube.
1. Run `composer install --no-dev` inside this folder.
1. Add `roundav` to `$config['plugins']` in your Roundcube config.
