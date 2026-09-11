import { Chat } from './Chat';

export const Notifications = {
    sendAlert: (msg) => Chat.message(String(msg)),
};
