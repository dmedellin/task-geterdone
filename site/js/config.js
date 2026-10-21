// Public identifiers only. A SPA has no secret: PKCE replaces it.
// Same Entra app registration as learn.geterdone.io ("All Microsoft account users").
export const CLIENT_ID = '5eb7789c-2954-4d7d-bf0a-39f9ae5cc90f';
export const AUTHORITY = 'https://login.microsoftonline.com/common';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SCOPES = 'openid profile offline_access User.Read Tasks.ReadWrite Files.ReadWrite.AppFolder';

export const redirectUri = () => location.origin + '/oauth2/spa/callback/';

// Name of the open extension stored on each To Do task.
export const EXT_NAME = 'io.geterdone.task';
// Folder inside the user's OneDrive app folder (Apps/<app name>/).
export const APP_DIR = 'task-geterdone';
