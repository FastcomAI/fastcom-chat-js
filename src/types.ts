/** Every message type a stream event or thread history can carry. */
export type MessageType = 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'LINK' | 'EMOJI' | 'STICKER';

/** The types an end user or agent may send. `LINK` is receive-only. */
export type SendableMessageType = 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'FILE';

/** What `/upload` classifies a file as. */
export type UploadedMediaType = 'IMAGE' | 'AUDIO' | 'FILE';

/** `POST /token` response. `expiresIn` is in seconds (1800 today). */
export interface SessionToken {
  token: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

/** `POST /message` and `POST /agent/reply` response. */
export interface SendMessageResult {
  messageId: string;
  conversationWithId: string;
}

/** `POST /upload` response. Send `url` as the content of a message with `messageType`. */
export interface UploadResult {
  url: string;
  messageType: UploadedMediaType;
}

/** `GET /config` response. */
export interface AppConfig {
  appId: string;
  name: string;
  botConnected: boolean;
  /** Whether an AI agent will actually answer on this app right now. */
  botActive: boolean;
}

export type RatingScoreOption = 'five_stars' | 'one_to_five' | 'five_emojis';

export interface RatingAnswer {
  /** Whole number, 1-5. */
  score: number;
  comment: string | null;
  /** ISO timestamp. */
  at: string;
}

/** A rating card, carried as `interaction` on a message event. */
export interface RatingCard {
  type: 'rating_card';
  title: string;
  subtitle: string;
  question: string | null;
  scoreOption: RatingScoreOption;
  /** Offer an optional comment box (up to 1000 characters). */
  comment: boolean;
  submitLabel: string;
  /** Null while the card is open. */
  answer: RatingAnswer | null;
}

/** `GET /rating` returns the newest unanswered card in this shape. */
export interface PendingRatingCard extends RatingCard {
  messageId: string;
  sentAt: string;
}

export interface SubmitRatingResult {
  /** `already_rated`: the ticket already had a score; `answer` is the one that counted. */
  status: 'recorded' | 'already_rated';
  answer: RatingAnswer;
}

/** A reply from the business (bot or human), as delivered on the stream. */
export interface ChatMessage {
  messageId: string;
  /** Plain text for TEXT/LINK, the media URL otherwise. */
  content: string;
  messageType: MessageType;
  isFromPage: boolean;
  platformMessageId: string;
  timestamp: string;
  /**
   * Present when the message should be drawn as an interactive element.
   * Only `rating_card` exists today; ignore unknown types and show `content`.
   */
  interaction?: RatingCard;
  /** Set when one bot reply was split into several messages. */
  groupId?: string;
  groupIndex?: number;
  groupSize?: number;
}

export interface ConnectedEvent {
  type: 'connected';
  appId: string;
  endUserId: string;
}

export interface MessageEvent extends ChatMessage {
  type: 'message';
}

/** A rating card was answered (on this or another device). */
export interface RatingEvent {
  type: 'rating';
  messageId: string;
  answer: RatingAnswer;
}

export type StreamEvent = ConnectedEvent | MessageEvent | RatingEvent;

/** One row of `GET /agent/messages`. */
export interface ThreadMessage {
  id: string;
  content: string;
  messageType: MessageType;
  isFromPage: boolean;
  platformMessageId: string;
  status: string;
  createdAt: string;
}

export interface ThreadPage {
  conversationWithId: string;
  /** Newest first. */
  messages: ThreadMessage[];
  hasMore: boolean;
}

export interface BotState {
  conversationWithId: string;
  botEnabled: boolean;
}
