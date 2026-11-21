import { SERVER_MESSAGES } from '@mystry/shared';

/** Messages returned by the server: the shared package is the single source of the English templates, which are merged straight into the English primary table here. */
export default {
  ...SERVER_MESSAGES,
} satisfies Record<string, string>;
