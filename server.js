import { createServer } from "http";
import { parse } from "url";

import next from "next";
import { Server } from "socket.io";
import nextEnv from "@next/env";
import mongoose from "mongoose";
import { jwtVerify } from "jose";
import webpush from "web-push";

const { loadEnvConfig } = nextEnv;


/* =======================================================
   LOAD ENV
======================================================= */

loadEnvConfig(process.cwd());


/* =======================================================
   WEB PUSH
======================================================= */

let webPushEnabled = false;

const vapidSubject =
  process.env.VAPID_SUBJECT;

const vapidPublicKey =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

const vapidPrivateKey =
  process.env.VAPID_PRIVATE_KEY;

if (
  vapidSubject &&
  vapidPublicKey &&
  vapidPrivateKey
) {
  try {
    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey,
    );

    webPushEnabled = true;

    console.log(
      "Web Push: enabled",
    );
  } catch (error) {
    console.error(
      "Web Push configuration error:",
      error,
    );
  }
} else {
  console.warn(
    "Web Push: disabled because VAPID environment variables are missing.",
  );
}


/* =======================================================
   NEXT CONFIG
======================================================= */

const dev =
  process.env.NODE_ENV !== "production";

/*
 * IMPORTANT:
 *
 * localhost works locally.
 * 0.0.0.0 is required when running on Render.
 */

const hostname =
  process.env.HOST || "0.0.0.0";

const port =
  Number(process.env.PORT) || 3000;


const app = next({
  dev,
  hostname,
  port,
});

const handle =
  app.getRequestHandler();


/* =======================================================
   MONGODB
======================================================= */

async function connectDB() {
  const uri =
    process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      "MONGODB_URI is not defined",
    );
  }

  if (
    mongoose.connection.readyState === 1
  ) {
    return;
  }

  await mongoose.connect(uri);

  console.log(
    "MongoDB connected",
  );
}


/* =======================================================
   SCHEMAS
======================================================= */


/* =======================================================
   USER SCHEMA
=======================================================

   We only need firstName and lastName for
   push notification sender name.

   IMPORTANT:
   This uses the existing "users" collection.

   It does NOT create a new collection.
======================================================= */

const UserSchema =
  new mongoose.Schema(
    {
      firstName: {
        type: String,
      },

      lastName: {
        type: String,
      },
    },
    {
      collection: "users",
    },
  );


const User =
  mongoose.models.User ||
  mongoose.model(
    "User",
    UserSchema,
  );


/* =======================================================
   CONVERSATION SCHEMA
======================================================= */

const ConversationSchema =
  new mongoose.Schema(
    {
      participants: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
      ],

      conversationKey: {
        type: String,
        index: true,
      },

      lastMessage: {
        type: String,
        default: "",
      },

      lastMessageAt: {
        type: Date,
        default: Date.now,
      },
    },
    {
      timestamps: true,
    },
  );


/* =======================================================
   MESSAGE SCHEMA
======================================================= */

const MessageSchema =
  new mongoose.Schema(
    {
      conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Conversation",
        required: true,
        index: true,
      },

      senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },

      receiverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },

      text: {
        type: String,
        required: true,
        trim: true,
        maxlength: 2000,
      },

      read: {
        type: Boolean,
        default: false,
      },
    },
    {
      timestamps: true,
    },
  );


/* =======================================================
   PUSH SUBSCRIPTION SCHEMA
======================================================= */

const PushSubscriptionSchema =
  new mongoose.Schema(
    {
      userId: {
        type: String,
        required: true,
        index: true,
      },

      endpoint: {
        type: String,
        required: true,
        unique: true,
      },

      keys: {
        p256dh: {
          type: String,
          required: true,
        },

        auth: {
          type: String,
          required: true,
        },
      },
    },
    {
      timestamps: true,
    },
  );


/* =======================================================
   MODELS
======================================================= */

const Conversation =
  mongoose.models.Conversation ||
  mongoose.model(
    "Conversation",
    ConversationSchema,
  );


const Message =
  mongoose.models.Message ||
  mongoose.model(
    "Message",
    MessageSchema,
  );


const PushSubscription =
  mongoose.models.PushSubscription ||
  mongoose.model(
    "PushSubscription",
    PushSubscriptionSchema,
  );


/* =======================================================
   HELPERS
======================================================= */

function createConversationKey(
  userA,
  userB,
) {
  return [
    String(userA),
    String(userB),
  ]
    .sort()
    .join("_");
}


/* =======================================================
   PARSE COOKIES
======================================================= */

function parseCookies(
  cookieHeader = "",
) {
  const cookies = {};

  cookieHeader
    .split(";")
    .forEach((part) => {
      const index =
        part.indexOf("=");

      if (index === -1) {
        return;
      }

      const key =
        part
          .slice(0, index)
          .trim();

      const value =
        part
          .slice(index + 1)
          .trim();

      try {
        cookies[key] =
          decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    });

  return cookies;
}


/* =======================================================
   VERIFY AUTH TOKEN
======================================================= */

async function verifyAuthToken(
  token,
) {
  try {
    if (!token) {
      return null;
    }

    const secret =
      process.env.AUTH_SECRET;

    if (!secret) {
      console.error(
        "AUTH_SECRET missing",
      );

      return null;
    }

    const secretKey =
      new TextEncoder().encode(
        secret,
      );

    const { payload } =
      await jwtVerify(
        token,
        secretKey,
        {
          algorithms: ["HS256"],
        },
      );

    if (
      typeof payload.userId !==
        "string" ||
      !payload.userId
    ) {
      return null;
    }

    return {
      userId:
        payload.userId,
    };
  } catch (error) {
    console.error(
      "Socket JWT error:",
      error?.message || error,
    );

    return null;
  }
}


/* =======================================================
   OBJECT ID VALIDATION
======================================================= */

function isValidObjectId(id) {
  return mongoose.isValidObjectId(
    id,
  );
}


/* =======================================================
   GET SENDER NAME
======================================================= */

async function getSenderName(
  userId,
) {
  try {
    const user =
      await User.findById(
        userId,
      )
        .select(
          "firstName lastName",
        )
        .lean();

    if (!user) {
      return "Someone";
    }

    const firstName =
      typeof user.firstName ===
      "string"
        ? user.firstName.trim()
        : "";

    const lastName =
      typeof user.lastName ===
      "string"
        ? user.lastName.trim()
        : "";

    const fullName =
      `${firstName} ${lastName}`.trim();

    return (
      fullName ||
      "Someone"
    );
  } catch (error) {
    console.error(
      "GET_SENDER_NAME_ERROR:",
      error,
    );

    return "Someone";
  }
}


/* =======================================================
   WEB PUSH HELPER
======================================================= */

async function sendPushNotificationToUser(
  userId,
  payload,
) {
  if (!webPushEnabled) {
    return;
  }

  try {
    const subscriptions =
      await PushSubscription.find({
        userId: String(userId),
      }).lean();

    if (
      !subscriptions.length
    ) {
      return;
    }

    const results =
      await Promise.allSettled(
        subscriptions.map(
          async (subscription) => {
            const pushSubscription =
              {
                endpoint:
                  subscription.endpoint,

                keys: {
                  p256dh:
                    subscription
                      .keys
                      .p256dh,

                  auth:
                    subscription
                      .keys
                      .auth,
                },
              };

            try {
              await webpush.sendNotification(
                pushSubscription,
                JSON.stringify(
                  payload,
                ),
                {
                  TTL: 60 * 60,
                  urgency: "high",
                },
              );

              console.log(
                "Push notification sent:",
                {
                  userId:
                    String(
                      userId,
                    ),

                  endpoint:
                    subscription.endpoint,
                },
              );
            } catch (error) {
              const statusCode =
                error?.statusCode;

              /*
               * 404 / 410 means subscription
               * is no longer valid.
               */

              if (
                statusCode === 404 ||
                statusCode === 410
              ) {
                await PushSubscription.deleteOne(
                  {
                    _id:
                      subscription._id,
                  },
                );

                console.log(
                  "Removed expired push subscription:",
                  subscription.endpoint,
                );
              }

              throw error;
            }
          },
        ),
      );

    for (
      const result of results
    ) {
      if (
        result.status ===
        "rejected"
      ) {
        console.error(
          "Push send failed:",
          result.reason,
        );
      }
    }
  } catch (error) {
    /*
     * Push failure must NEVER break
     * normal messaging.
     */

    console.error(
      "WEB_PUSH_SEND_ERROR:",
      error,
    );
  }
}


/* =======================================================
   NEXT SERVER
======================================================= */

await app.prepare();


const httpServer =
  createServer(
    async (req, res) => {
      try {
        const parsedUrl =
          parse(
            req.url,
            true,
          );

        await handle(
          req,
          res,
          parsedUrl,
        );
      } catch (error) {
        console.error(
          "Next request error:",
          error,
        );

        res.statusCode = 500;

        res.end(
          "Internal server error",
        );
      }
    },
  );


/* =======================================================
   SOCKET CORS
=======================================================

   Local:
   http://localhost:3000

   Production:
   CLIENT_URL from Render environment variables

   Example:

   CLIENT_URL=https://your-app.vercel.app
======================================================= */

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.CLIENT_URL,
].filter(Boolean);


console.log(
  "Socket allowed origins:",
  allowedOrigins,
);


/* =======================================================
   SOCKET.IO
======================================================= */

const io =
  new Server(
    httpServer,
    {
      path: "/socket.io",

      cors: {
        origin:
          allowedOrigins,

        credentials: true,
      },

      transports: [
        "websocket",
        "polling",
      ],

      pingTimeout: 20000,

      pingInterval: 25000,
    },
  );


/* =======================================================
   SOCKET AUTHENTICATION
=======================================================

   PRODUCTION:

   Client sends:

   io(SOCKET_URL, {
     auth: {
       token: socketToken,
     }
   });

   LOCAL DEVELOPMENT:

   matrimonial_session cookie can still
   be used as a fallback.

======================================================= */

io.use(
  async (socket, next) => {
    try {

      /* ===================================================
         1. FIRST: SOCKET AUTH TOKEN
      =================================================== */

      let token =
        socket.handshake.auth?.token;


      /* ===================================================
         2. FALLBACK: AUTH COOKIE
      ===================================================

         This keeps local development compatible
         with your existing authentication.
      =================================================== */

      if (!token) {
        const cookieHeader =
          socket.handshake.headers
            .cookie || "";

        const cookies =
          parseCookies(
            cookieHeader,
          );

        token =
          cookies.matrimonial_session;
      }


      /* ===================================================
         3. TOKEN REQUIRED
      =================================================== */

      if (!token) {
        console.error(
          "Socket: authentication token missing",
        );

        return next(
          new Error(
            "Unauthorized",
          ),
        );
      }


      /* ===================================================
         4. VERIFY JWT
      =================================================== */

      const session =
        await verifyAuthToken(
          token,
        );


      if (!session) {
        console.error(
          "Socket: invalid authentication token",
        );

        return next(
          new Error(
            "Unauthorized",
          ),
        );
      }


      /* ===================================================
         5. STORE USER ID
      =================================================== */

      socket.userId =
        String(
          session.userId,
        );


      console.log(
        "Socket authentication successful:",
        {
          socketId:
            socket.id,

          userId:
            socket.userId,

          authMethod:
            socket.handshake.auth?.token
              ? "socket-token"
              : "cookie",
        },
      );


      next();
    } catch (error) {
      console.error(
        "Socket middleware error:",
        error,
      );

      next(
        new Error(
          "Socket authentication failed",
        ),
      );
    }
  },
);


/* =======================================================
   ONLINE USERS
======================================================= */

const onlineUsers =
  new Map();


/* =======================================================
   SOCKET CONNECTION
======================================================= */

io.on(
  "connection",
  (socket) => {

    const userId =
      String(
        socket.userId,
      );


    console.log(
      "Socket connected:",
      socket.id,
      "user:",
      userId,
    );


    /* ===================================================
       ADD USER SOCKET
    =================================================== */

    if (
      !onlineUsers.has(userId)
    ) {
      onlineUsers.set(
        userId,
        new Set(),
      );
    }


    onlineUsers
      .get(userId)
      .add(socket.id);


    /* ===================================================
       PERSONAL USER ROOM
    =================================================== */

    socket.join(
      `user:${userId}`,
    );


    /* ===================================================
       PRESENCE
    =================================================== */

    io.emit(
      "presence:update",
      {
        userId,
        online: true,
      },
    );


    /* =====================================================
       JOIN CONVERSATION
    ===================================================== */

    socket.on(
      "conversation:join",
      async (payload) => {
        try {

          const conversationId =
            payload?.conversationId;


          if (
            !conversationId ||
            !isValidObjectId(
              conversationId,
            )
          ) {
            return;
          }


          const conversation =
            await Conversation.findOne(
              {
                _id:
                  conversationId,

                participants:
                  userId,
              },
            ).lean();


          if (!conversation) {
            console.warn(
              "Unauthorized conversation join:",
              userId,
              conversationId,
            );

            return;
          }


          socket.join(
            `conversation:${conversationId}`,
          );


          console.log(
            `User ${userId} joined conversation ${conversationId}`,
          );
        } catch (error) {
          console.error(
            "conversation:join error:",
            error,
          );
        }
      },
    );


    /* =====================================================
       LEAVE CONVERSATION
    ===================================================== */

    socket.on(
      "conversation:leave",
      (payload) => {

        const conversationId =
          payload?.conversationId;


        if (!conversationId) {
          return;
        }


        socket.leave(
          `conversation:${conversationId}`,
        );


        console.log(
          `User ${userId} left conversation ${conversationId}`,
        );
      },
    );


    /* =====================================================
       SEND MESSAGE
    ===================================================== */

    socket.on(
      "message:send",
      async (
        payload,
        callback,
      ) => {
        try {

          const conversationId =
            payload?.conversationId;


          const text =
            typeof payload?.text ===
            "string"
              ? payload.text.trim()
              : "";


          /* ===============================================
             VALIDATE CONVERSATION
          =============================================== */

          if (!conversationId) {
            callback?.({
              success: false,
              message:
                "Conversation ID is required",
            });

            return;
          }


          if (
            !isValidObjectId(
              conversationId,
            )
          ) {
            callback?.({
              success: false,
              message:
                "Invalid conversation ID",
            });

            return;
          }


          /* ===============================================
             VALIDATE MESSAGE
          =============================================== */

          if (!text) {
            callback?.({
              success: false,
              message:
                "Message text is required",
            });

            return;
          }


          if (
            text.length > 2000
          ) {
            callback?.({
              success: false,
              message:
                "Message cannot exceed 2000 characters",
            });

            return;
          }


          /* ===============================================
             FIND CONVERSATION
          =============================================== */

          const conversation =
            await Conversation.findOne(
              {
                _id:
                  conversationId,

                participants:
                  userId,
              },
            );


          if (!conversation) {
            callback?.({
              success: false,
              message:
                "Conversation not found",
            });

            return;
          }


          /* ===============================================
             FIND RECEIVER
          =============================================== */

          const receiverId =
            conversation.participants.find(
              (participantId) =>
                String(
                  participantId,
                ) !== userId,
            );


          if (!receiverId) {
            callback?.({
              success: false,
              message:
                "Receiver not found",
            });

            return;
          }


          const receiverUserId =
            String(
              receiverId,
            );


          /* ===============================================
             GET SENDER NAME
          =============================================== */

          const senderName =
            await getSenderName(
              userId,
            );


          /* ===============================================
             SAVE MESSAGE
          =============================================== */

          const message =
            await Message.create(
              {
                conversationId:
                  conversation._id,

                senderId:
                  new mongoose.Types.ObjectId(
                    userId,
                  ),

                receiverId,

                text,

                read: false,
              },
            );


          /* ===============================================
             UPDATE CONVERSATION
          =============================================== */

          await Conversation.findByIdAndUpdate(
            conversation._id,
            {
              $set: {
                lastMessage:
                  text,

                lastMessageAt:
                  message.createdAt,
              },
            },
          );


          /* ===============================================
             MESSAGE PAYLOAD
          =============================================== */

          const messagePayload =
            {
              conversationId:
                String(
                  conversation._id,
                ),

              message: {
                id:
                  String(
                    message._id,
                  ),

                _id:
                  String(
                    message._id,
                  ),

                conversationId:
                  String(
                    message.conversationId,
                  ),

                senderId:
                  String(
                    message.senderId,
                  ),

                receiverId:
                  String(
                    message.receiverId,
                  ),

                text:
                  message.text,

                read:
                  message.read,

                createdAt:
                  message.createdAt?.toISOString(),

                updatedAt:
                  message.updatedAt?.toISOString(),
              },
            };


          /* ===============================================
             SEND TO SENDER
          =============================================== */

          io.to(
            `user:${userId}`,
          ).emit(
            "message:new",
            messagePayload,
          );


          /* ===============================================
             SEND TO RECEIVER
          =============================================== */

          io.to(
            `user:${receiverUserId}`,
          ).emit(
            "message:new",
            messagePayload,
          );


          /* =================================================
             WEB PUSH

             Only send when receiver does NOT
             currently have an active socket.
          ================================================= */

          const receiverSockets =
            onlineUsers.get(
              receiverUserId,
            );


          const receiverIsOnline =
            receiverSockets &&
            receiverSockets.size > 0;


          if (
            !receiverIsOnline
          ) {
            await sendPushNotificationToUser(
              receiverUserId,
              {
                title:
                  `${senderName} sent you a message`,

                body:
                  text.length > 100
                    ? `${text.substring(
                        0,
                        100,
                      )}...`
                    : text,

                senderName,

                icon:
                  "/icons/icon-192.png",

                badge:
                  "/icons/icon-192.png",

                url:
                  `/messages?profile=${userId}`,

                conversationId:
                  String(
                    conversation._id,
                  ),

                senderId:
                  userId,

                tag:
                  `message-${String(
                    message._id,
                  )}`,
              },
            );
          }


          /* ===============================================
             ACK
          =============================================== */

          callback?.({
            success: true,
            message:
              "Message sent",
          });


          console.log(
            "Message sent:",
            {
              conversationId:
                String(
                  conversation._id,
                ),

              senderId:
                userId,

              senderName,

              receiverId:
                receiverUserId,

              text,

              pushSent:
                !receiverIsOnline &&
                webPushEnabled,
            },
          );

        } catch (error) {

          console.error(
            "message:send error:",
            error,
          );


          callback?.({
            success: false,
            message:
              "Unable to send message",
          });
        }
      },
    );


    /* =====================================================
       MESSAGE READ
    ===================================================== */

    socket.on(
      "message:read",
      async (
        payload,
        callback,
      ) => {
        try {

          const conversationId =
            payload?.conversationId;


          /* ===============================================
             VALIDATE CONVERSATION
          =============================================== */

          if (
            !conversationId ||
            !isValidObjectId(
              conversationId,
            )
          ) {
            callback?.({
              success: false,
              message:
                "Invalid conversation ID",
            });

            return;
          }


          /* ===============================================
             VERIFY PARTICIPANT
          =============================================== */

          const conversation =
            await Conversation.findOne(
              {
                _id:
                  conversationId,

                participants:
                  userId,
              },
            ).lean();


          if (!conversation) {
            callback?.({
              success: false,
              message:
                "Conversation not found",
            });

            return;
          }


          /* ===============================================
             FIND UNREAD MESSAGES
          =============================================== */

          const unreadMessages =
            await Message.find(
              {
                conversationId,

                receiverId:
                  userId,

                read: false,
              },
            )
              .select(
                "_id senderId",
              )
              .lean();


          /* ===============================================
             NOTHING TO UPDATE
          =============================================== */

          if (
            unreadMessages.length ===
            0
          ) {
            callback?.({
              success: true,
              messageIds: [],
            });

            return;
          }


          /* ===============================================
             MESSAGE IDS
          =============================================== */

          const messageIds =
            unreadMessages.map(
              (message) =>
                String(
                  message._id,
                ),
            );


          /* ===============================================
             UPDATE MONGODB
          =============================================== */

          await Message.updateMany(
            {
              _id: {
                $in:
                  unreadMessages.map(
                    (message) =>
                      message._id,
                  ),
              },

              receiverId:
                userId,

              read: false,
            },
            {
              $set: {
                read: true,
              },
            },
          );


          /* ===============================================
             NOTIFY ORIGINAL SENDERS
          =============================================== */

          for (
            const message of
            unreadMessages
          ) {

            io.to(
              `user:${String(
                message.senderId,
              )}`,
            ).emit(
              "message:read",
              {
                conversationId:
                  String(
                    conversationId,
                  ),

                messageId:
                  String(
                    message._id,
                  ),

                read: true,
              },
            );
          }


          /* ===============================================
             ACK
          =============================================== */

          callback?.({
            success: true,
            messageIds,
          });


          console.log(
            "Messages marked as read:",
            {
              conversationId:
                String(
                  conversationId,
                ),

              readerId:
                userId,

              messageIds,
            },
          );

        } catch (error) {

          console.error(
            "message:read error:",
            error,
          );


          callback?.({
            success: false,
            message:
              "Unable to mark messages as read",
          });
        }
      },
    );


    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      "disconnect",
      (reason) => {

        console.log(
          "Socket disconnected:",
          socket.id,
          "user:",
          userId,
          "reason:",
          reason,
        );


        const userSockets =
          onlineUsers.get(
            userId,
          );


        if (userSockets) {

          userSockets.delete(
            socket.id,
          );


          /* ===============================================
             ONLY OFFLINE WHEN ALL
             TABS / DEVICES DISCONNECT
          =============================================== */

          if (
            userSockets.size === 0
          ) {

            onlineUsers.delete(
              userId,
            );


            io.emit(
              "presence:update",
              {
                userId,
                online: false,
              },
            );
          }
        }
      },
    );
  },
);


/* =======================================================
   START SERVER
======================================================= */

httpServer.listen(
  port,
  hostname,
  async () => {

    try {

      await connectDB();


      console.log("");

      console.log(
        "========================================",
      );


      console.log(
        `Server listening on port: ${port}`,
      );


      console.log(
        `Socket.IO path: /socket.io`,
      );


      console.log(
        `Web Push: ${
          webPushEnabled
            ? "Enabled"
            : "Disabled"
        }`,
      );


      console.log(
        "Allowed Socket Origins:",
        allowedOrigins,
      );


      console.log(
        "========================================",
      );


      console.log("");

    } catch (error) {

      console.error(
        "MongoDB connection failed:",
        error,
      );
    }
  },
);