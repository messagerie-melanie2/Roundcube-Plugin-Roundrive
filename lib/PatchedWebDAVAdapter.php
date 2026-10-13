<?php

use League\Flysystem\Config;
use League\Flysystem\UnableToCreateDirectory;
use League\Flysystem\WebDAV\WebDAVAdapter;

/**
 * Patched WebDAVAdapter that fixes the createDirectory bug.
 *
 * Upstream PR: https://github.com/thephpleague/flysystem/pull/1852
 *
 * Two bugs in the original createDirectory():
 *  1. Empty path segments (from leading slash) trigger `return`, aborting the loop entirely.
 *  2. $location is missing a leading slash, causing MKCOL requests to fail.
 *
 * Because $client and $prefixer are private in the parent, we access them via ReflectionClass.
 */
class PatchedWebDAVAdapter extends WebDAVAdapter
{
    public function createDirectory(string $path, Config $config): void
    {
        $reflection = new ReflectionClass(WebDAVAdapter::class);

        $prefixerProp = $reflection->getProperty('prefixer');
        $clientProp   = $reflection->getProperty('client');

        // setAccessible() is required before PHP 8.1; deprecated (no-op) from 8.1 onward.
        if (PHP_VERSION_ID < 80100) {
            $prefixerProp->setAccessible(true);
            $clientProp->setAccessible(true);
        }

        $prefixer = $prefixerProp->getValue($this);
        $client   = $clientProp->getValue($this);

        $parts = explode('/', $prefixer->prefixDirectoryPath($path));
        $directoryParts = [];

        foreach ($parts as $directory) {
            if ($directory === '.' || $directory === '') {
                continue; // fix #1: was `return`, which aborted the entire method
            }

            $directoryParts[] = $directory;
            $directoryPath = implode('/', $directoryParts);
            $location = '/' . $this->encodePath($directoryPath) . '/'; // fix #2: added leading '/'

            // directoryExists() encodes the path itself: pass the plain one.
            if ($this->directoryExists($prefixer->stripDirectoryPrefix('/' . $directoryPath . '/'))) {
                continue;
            }

            try {
                $response = $client->request('MKCOL', $location);
            } catch (Throwable $exception) {
                throw UnableToCreateDirectory::dueToFailure($path, $exception);
            }

            if ($response['statusCode'] !== 201) {
                throw UnableToCreateDirectory::atLocation($path, 'Failed to create directory at: ' . $location . ': ' . $response['body']);
            }
        }
    }
}
