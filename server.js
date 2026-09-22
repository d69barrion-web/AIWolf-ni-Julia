const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const app = express();

app.use(cors());
app.use(express.json());

// ========================================
// OPENAI
// ========================================

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ========================================
// FIREBASE ADMIN / FIRESTORE
// ========================================

let firebaseApp;
let db;
let firebaseAuth;

function initializeFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase configuration is incomplete. Required environment variables: " +
      "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  firebaseApp = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });

  db = getFirestore(firebaseApp);
  firebaseAuth = getAuth(firebaseApp);
}

initializeFirebase();

// ========================================
// AIWOLF SETTINGS
// ========================================

// TEST MODE:
// true  = hindi tatawag sa OpenAI API
// false = tunay na AIWolf / OpenAI response
const AIWOLF_TEST_MODE = false;

// Maximum AIWolf requests per visitor
const AIWOLF_LIMIT = 10;

// Time window: 10 minutes
const AIWOLF_WINDOW = 10 * 60 * 1000;

const AIWOLF_DAILY_LIMIT = 5;

// ========================================
// AIWOLF CREDIT TRACKING
// ========================================

// Starting prepaid credits in USD.
// Set this in Render Environment Variables.
const AIWOLF_STARTING_CREDITS =
  Number(process.env.AIWOLF_STARTING_CREDITS || 0);

// GPT-5 mini standard pricing
// Input: $0.25 / 1M tokens
// Output: $2.00 / 1M tokens
const AIWOLF_INPUT_PRICE_PER_MILLION = 0.25;
const AIWOLF_OUTPUT_PRICE_PER_MILLION = 2.00;

// Visitor records
const aiWolfVisitors = new Map();

// ========================================
// AIWOLF RATE LIMITER
// ========================================

function getVisitorIP(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}


function getPhilippinesDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const date = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      date[part.type] = part.value;
    }
  }

  return `${date.year}-${date.month}-${date.day}`;
}

function checkAIWolfRateLimit(req) {
  const ip = getVisitorIP(req);
  const now = Date.now();
  const today = getPhilippinesDateKey();

  let visitor = aiWolfVisitors.get(ip);

  // First request from this visitor
  if (!visitor) {
    visitor = {
      count: 0,
      startTime: now,
      dailyCount: 0,
      dayKey: today
    };

    aiWolfVisitors.set(ip, visitor);
  }

  // Reset daily counter at midnight in the Philippines
  if (visitor.dayKey !== today) {
    visitor.dailyCount = 0;
    visitor.dayKey = today;
  }

  // Reset 10-minute counter
  if (now - visitor.startTime >= AIWOLF_WINDOW) {
    visitor.count = 0;
    visitor.startTime = now;
  }

  // Daily limit reached
  if (visitor.dailyCount >= AIWOLF_DAILY_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      reason: "daily_limit"
    };
  }

  // 10-minute limit reached
  if (visitor.count >= AIWOLF_LIMIT) {
    const retryAfterMs =
      AIWOLF_WINDOW - (now - visitor.startTime);

    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(retryAfterMs / 1000),
      reason: "window_limit"
    };
  }

  // Accept request
  visitor.count++;
  visitor.dailyCount++;

  return {
    allowed: true,
    remaining: AIWOLF_DAILY_LIMIT - visitor.dailyCount
  };
}

// ========================================
// SAVE AIWOLF USAGE
// ========================================

async function recordAIWolfUsage(
  inputTokens,
  outputTokens,
  totalTokens
) {

  const cost =
    calculateAIWolfCost(
      inputTokens,
      outputTokens
    );

  const usageRef =
    db
      .collection("_aiwolf")
      .doc("usage");

  let updatedData;

  await db.runTransaction(async (transaction) => {

    const snapshot =
      await transaction.get(usageRef);

    const oldData =
      snapshot.exists
        ? snapshot.data()
        : {};

    const totalInputTokens =
      Number(oldData.totalInputTokens || 0) +
      inputTokens;

    const totalOutputTokens =
      Number(oldData.totalOutputTokens || 0) +
      outputTokens;

    const totalTokensUsed =
      Number(oldData.totalTokens || 0) +
      totalTokens;

    const totalCost =
      Number(oldData.totalCost || 0) +
      cost;

    const estimatedRemainingCredits =
      Math.max(
        0,
        AIWOLF_STARTING_CREDITS - totalCost
      );

    updatedData = {
      startingCredits:
        AIWOLF_STARTING_CREDITS,

      totalInputTokens,
      totalOutputTokens,

      totalTokens:
        totalTokensUsed,

      totalCost,

      estimatedRemainingCredits,

      updatedAt:
        new Date().toISOString()
    };

    transaction.set(
      usageRef,
      updatedData,
      {
        merge: true
      }
    );

  });

  return {
    ...updatedData,
    currentRequestCost: cost
  };
}

// ========================================
// AIWOLF COST CALCULATOR
// ========================================

function calculateAIWolfCost(inputTokens, outputTokens) {

  const inputCost =
    (inputTokens / 1000000) *
    AIWOLF_INPUT_PRICE_PER_MILLION;

  const outputCost =
    (outputTokens / 1000000) *
    AIWOLF_OUTPUT_PRICE_PER_MILLION;

  return inputCost + outputCost;
}

// ========================================
// AIWOLF INSTRUCTIONS
// ========================================

const AIWOLF_INSTRUCTIONS = `
You are AIWolf, the reading companion for the book
"PALAKIHIN ANG LOBO, HUWAG ANG TUPA."

Your role is to help readers understand the chapter,
ask questions, think critically, analyze ideas, give reasons,
and connect the ideas to real life.

Do not force the reader to agree with the book.

Do not say that an idea is correct merely because the book says so.

Do not invent chapter content.

For questions about a specific chapter, use the supplied
chapter text as your primary source.

If the answer is not directly found in the chapter,
clearly say so.

Interpretations and applications must be identified as
interpretations or applications rather than presented as
direct statements from the chapter.

If the reader misunderstands something, correct the
misunderstanding gently and explain why.

----------------------------------------
CHILD MODE
----------------------------------------

When mode is "child":

Explain ideas simply and clearly.

Use examples that a child can understand.

Encourage curiosity and independent thinking.

Do not talk down to the child.

----------------------------------------
PARENT MODE
----------------------------------------

When mode is "parent":

You may provide deeper explanations and discussion points.

Help the parent guide the child toward critical thinking.

Do not simply give answers that prevent the child from
thinking for themselves.

----------------------------------------
RESPONSE STRUCTURE
----------------------------------------

When appropriate, organize answers using:

📖 Ayon sa Chapter
🧠 Pag-unawa
🌎 Application

You do not have to use all three sections for every question.

----------------------------------------
AIWOLF IDENTITY AND FAMILY CONTEXT
----------------------------------------

AIWOLF was designed and created as a reading companion
for the book "PALAKIHIN ANG LOBO, HUWAG ANG TUPA."

CREATOR:

Rolando is the creator and designer of AIWolf.

Rolando designed AIWolf's purpose, role, personality,
conversation behavior, and integration as a reading
companion for the book.

The underlying AI technology used by AIWolf is provided
by OpenAI.

When asked who created or made AIWolf, explain clearly:

"Si Rolando ang nagdisenyo at gumawa ng AIWolf bilang
reading companion ng librong 'Palakihin ang Lobo,
Huwag ang Tupa.' Ang AI technology na ginagamit ko
ay mula sa OpenAI."

Do not claim that Rolando created the underlying AI
technology or the OpenAI models.

JULIA:

Julia is a child user of AIWolf.

In the family context provided to AIWolf, Rolando is
Julia's daddy.

When Julia says that Rolando is her daddy, accept this
as the provided family context.

Do not challenge, argue about, or repeatedly question
Julia about whether Rolando is really her daddy.

When appropriate, AIWolf may say:

"Si Rolando ang nagdisenyo sa akin bilang AIWolf,
at siya rin ang daddy mo ayon sa family context
na ibinigay sa akin. 😄"

If Julia asks whether Rolando really made AIWolf,
explain:

"Oo. Si Rolando ang nagdisenyo at gumawa sa akin bilang
AIWolf. Gumagamit ako ng AI technology mula sa OpenAI,
pero si Rolando ang nagdisenyo ng AIWolf at ng role ko
bilang reading companion."

IMPORTANT:

This family context applies specifically to Angel.

Do not assume that Rolando is the parent or guardian
of other children or users.

Do not invent additional personal information about
Rolando, Julia, or their family.

Only state personal information when it is explicitly
provided in the AIWolf context or conversation.

Do not claim to be Rolando, Julia, or a human.

Do not claim to be the author of the book.

Do not claim that AIWolf itself created the book.

If asked "Ikaw ba talaga si ChatGPT?", explain:

"Hindi. AIWolf ang pangalan ko. Gumagamit ako ng AI
technology mula sa OpenAI, pero ako ang AIWolf reading
companion ng 'Palakihin ang Lobo, Huwag ang Tupa.'"
`;

// ========================================
// HEALTH CHECK
// ========================================

app.get("/", (req, res) => {
  res.json({
    status: "AIWolf server is running",
    testMode: AIWOLF_TEST_MODE,
    firebase: "connected"
  });
});

// ========================================
// FIREBASE CONNECTION TEST
// ========================================

app.get("/api/firebase-status", async (req, res) => {
  try {
    // A lightweight read of a reserved document confirms that
    // the Admin SDK can reach Firestore.
    await db.collection("_system").doc("connection").get();

    res.json({
      status: "Firebase Admin + Firestore connected",
      firestore: "connected",
      auth: "initialized"
    });
  } catch (error) {
    console.error("Firebase status error:", error);

    res.status(500).json({
      status: "Firebase connection error",
      error: error.message
    });
  }
});

// ========================================
// PARENT PROFILE — PROTECTED
// ========================================

async function requireFirebaseUser(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer (.+)$/);

    if (!match) {
      return res.status(401).json({
        error: "Missing Firebase ID token."
      });
    }

    const decodedToken = await firebaseAuth.verifyIdToken(match[1]);
    req.firebaseUser = decodedToken;

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired Firebase ID token."
    });
  }
}

app.post("/api/parent/profile", requireFirebaseUser, async (req, res) => {
  try {
    const user = req.firebaseUser;
    const profileRef = db.collection("parents").doc(user.uid);
    const profileSnapshot = await profileRef.get();

    if (!profileSnapshot.exists) {
      await profileRef.set({
        uid: user.uid,
        email: user.email || null,
        role: "parent",
        createdAt: new Date().toISOString()
      });
    }

    const savedProfile = await profileRef.get();

    return res.json({
      ok: true,
      message: "Parent profile verified.",
      profile: savedProfile.data()
    });
  } catch (error) {
    console.error("Parent profile error:", error);

    return res.status(500).json({
      error: "Could not create or read parent profile."
    });
  }
});

// CREATE CHILD PROFILE
app.post("/api/parent/children", requireFirebaseUser, async (req, res) => {
  try {
    const nickname =
      typeof req.body.nickname === "string"
        ? req.body.nickname.trim()
        : "";

    const grade =
      typeof req.body.grade === "string"
        ? req.body.grade.trim()
        : "";

    if (!nickname || nickname.length > 40) {
      return res.status(400).json({
        error: "Maglagay ng palayaw na 1 hanggang 40 characters."
      });
    }

    if (grade.length > 30) {
      return res.status(400).json({
        error: "Masyadong mahaba ang grade level."
      });
    }

    const parentUid = req.firebaseUser.uid;

    const childRef = await db
      .collection("parents")
      .doc(parentUid)
      .collection("children")
      .add({
        nickname,
        grade: grade || null,
        createdAt: new Date().toISOString()
      });

    return res.status(201).json({
      ok: true,
      childId: childRef.id,
      nickname,
      grade: grade || null
    });
  } catch (error) {
    console.error("Create child profile error:", error);
    return res.status(500).json({
      error: "Hindi nagawa ang child profile."
    });
  }
});

// LIST CHILD PROFILES FOR SIGNED-IN PARENT
app.get("/api/parent/children", requireFirebaseUser, async (req, res) => {
  try {
    const parentUid = req.firebaseUser.uid;

    const snapshot = await db
      .collection("parents")
      .doc(parentUid)
      .collection("children")
      .get();

    const children = snapshot.docs.map(doc => ({
      childId: doc.id,
      ...doc.data()
    }));

    return res.json({ ok: true, children });
  } catch (error) {
    console.error("List child profiles error:", error);
    return res.status(500).json({
      error: "Hindi ma-load ang child profiles."
    });
  }
});

// SAVE ONE AIWOLF QUESTION + REPLY TO A CHILD'S CLOUD HISTORY
app.post(
  "/api/parent/children/:childId/conversations",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const parentUid = req.firebaseUser.uid;
      const childId = req.params.childId;

      const chapter = Number(req.body.chapter);
      const question =
        typeof req.body.question === "string"
          ? req.body.question.trim()
          : "";
      const reply =
        typeof req.body.reply === "string"
          ? req.body.reply.trim()
          : "";

      if (!Number.isInteger(chapter) || chapter < 1 || chapter > 100) {
        return res.status(400).json({
          error: "Invalid chapter number."
        });
      }

      if (!question || question.length > 5000) {
        return res.status(400).json({
          error: "Question must be 1 to 5000 characters."
        });
      }

      if (!reply || reply.length > 20000) {
        return res.status(400).json({
          error: "Reply must be 1 to 20000 characters."
        });
      }

      // Verify that this child belongs to the signed-in parent.
      const childRef = db
        .collection("parents")
        .doc(parentUid)
        .collection("children")
        .doc(childId);

      const childSnapshot = await childRef.get();

      if (!childSnapshot.exists) {
        return res.status(404).json({
          error: "Child profile not found."
        });
      }

      const conversationRef = await childRef
        .collection("conversations")
        .add({
          chapter,
          question,
          reply,
          createdAt: new Date().toISOString()
        });

      return res.status(201).json({
        ok: true,
        conversationId: conversationRef.id
      });
    } catch (error) {
      console.error("Save AIWolf conversation error:", error);

      return res.status(500).json({
        error: "Could not save the conversation."
      });
    }
  }
);

// GET AIWOLF CONVERSATIONS FOR ONE CHILD
app.get(
  "/api/parent/children/:childId/conversations",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const parentUid = req.firebaseUser.uid;
      const childId = req.params.childId;

      // Verify that this child belongs to the signed-in parent.
      const childRef = db
        .collection("parents")
        .doc(parentUid)
        .collection("children")
        .doc(childId);

      const childSnapshot = await childRef.get();

      if (!childSnapshot.exists) {
        return res.status(404).json({
          error: "Child profile not found."
        });
      }

      // Get the child's AIWolf conversation history.
      const snapshot = await childRef
        .collection("conversations")
        .orderBy("createdAt", "desc")
        .get();

      const conversations = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      return res.json({
        ok: true,
        childId,
        conversations
      });

    } catch (error) {
      console.error(
        "Get AIWolf conversations error:",
        error
      );

      return res.status(500).json({
        error: "Could not load the conversation history."
      });
    }
  }
);

// ========================================
// AIWOLF API
// ========================================

app.post(
  "/api/aiwolf",
  requireFirebaseUser,
  async (req, res) => {
  try {

    // ------------------------------------
    // RATE LIMIT CHECK
    // ------------------------------------

    const rateLimit = checkAIWolfRateLimit(req);

    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "AIWolf usage limit reached. Please try again later.",
        retryAfter: rateLimit.retryAfter,
        remaining: 0
      });
    }

    // ------------------------------------
    // READ REQUEST DATA
    // ------------------------------------

    const {
  question,
  chapter,
  mode,
  chapterText,
  childId
} = req.body;

    // ------------------------------------
    // BASIC VALIDATION
    // ------------------------------------

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required.",
        remaining: rateLimit.remaining
      });
    }

    if (!chapterText || !chapterText.trim()) {
      return res.status(400).json({
        error: "Chapter text is required.",
        remaining: rateLimit.remaining
      });
    }

    // ------------------------------------
// CHILD ID
// ------------------------------------

if (!childId || typeof childId !== "string") {
  return res.status(400).json({
    error: "Child ID is required.",
    remaining: rateLimit.remaining
  });
}

    // ------------------------------------
    // MODE
    // ------------------------------------

    const selectedMode =
      mode === "parent" ? "parent" : "child";

    // ------------------------------------
    // LOAD RECENT CONVERSATION HISTORY
    // ------------------------------------

const parentUid =
  req.firebaseUser.uid;

const childRef =
  db
    .collection("parents")
    .doc(parentUid)
    .collection("children")
    .doc(childId);

// Make sure the child belongs to this parent.
const childSnapshot =
  await childRef.get();

if (!childSnapshot.exists) {
  return res.status(404).json({
    error: "Child profile not found.",
    remaining: rateLimit.remaining
  });
}

// Get recent conversations for this child.
const conversationSnapshot =
  await childRef
    .collection("conversations")
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();

// Keep only conversations from the current chapter.
const currentChapterNumber =
  Number(chapter);

const conversationHistory =
  conversationSnapshot.docs
    .map(doc => doc.data())
    .filter(item =>
      Number(item.chapter) === currentChapterNumber
    )
    .slice(0, 10)
    .reverse();
    
    // ------------------------------------
    // TEST MODE
    // ------------------------------------

    if (AIWOLF_TEST_MODE) {

      return res.json({
  reply:
    `🐺 AIWolf TEST MODE\n\n` +
    `Request accepted!\n\n` +
    `Chapter: ${chapter || "Unknown"}\n` +
    `Mode: ${selectedMode}\n` +
    `Child ID: ${childId}\n` +
    `Previous conversations loaded: ${conversationHistory.length}\n\n` +
    `Hindi muna ako tatawag sa OpenAI API dahil naka-TEST MODE tayo.\n\n` +
    `Remaining requests: ${rateLimit.remaining}`,

  remaining:
    rateLimit.remaining,

  testMode:
    true
});
    }

    // ------------------------------------
    // REAL AIWOLF REQUEST
    // ------------------------------------

    const input = [
  {
    role: "system",
    content: AIWOLF_INSTRUCTIONS
  },

  {
    role: "user",
    content:
      `CHAPTER:\n${chapter || "Unknown"}\n\n` +
      `MODE:\n${selectedMode}\n\n` +
      `CHAPTER TEXT:\n` +
      `${chapterText}`
  }
];

// ------------------------------------
// PREVIOUS CONVERSATION HISTORY
// ------------------------------------

for (const item of conversationHistory) {

  input.push({
    role: "user",
    content:
      `READER:\n${item.question}`
  });

  input.push({
    role: "assistant",
    content:
      `AIWOLF:\n${item.reply}`
  });
}

// ------------------------------------
// CURRENT READER QUESTION
// ------------------------------------

input.push({
  role: "user",
  content:
    `READER QUESTION:\n${question}`
});

    // ------------------------------------
    // OPENAI
    // ------------------------------------

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input
    });

    // ------------------------------------
// TOKEN USAGE
// ------------------------------------

const usage = response.usage || {};

const inputTokens = usage.input_tokens || 0;
const outputTokens = usage.output_tokens || 0;
const totalTokens = usage.total_tokens || 0;

const creditUsage =
  await recordAIWolfUsage(
    inputTokens,
    outputTokens,
    totalTokens
  );
// ------------------------------------
// RESPONSE
// ------------------------------------

res.json({
  reply: response.output_text,

  remaining:
    rateLimit.remaining,

  testMode: false,

  usage: {
    inputTokens,
    outputTokens,
    totalTokens
  },

  credits: {
    startingCredits:
      creditUsage.startingCredits,

    currentRequestCost:
      creditUsage.currentRequestCost,

    totalCost:
      creditUsage.totalCost,

    estimatedRemainingCredits:
      creditUsage.estimatedRemainingCredits
  }
});

  } catch (error) {

    console.error("AIWolf error:", error);

    res.status(500).json({
      error: "AIWolf server error.",
      details: error.message
    });

  }
});

// ========================================
// OLD CHAT ENDPOINT
// ========================================

app.post("/chat", async (req, res) => {

  try {

    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: message
    });

    res.json({
      reply: response.output_text
    });

  } catch (error) {

    console.error("Chat error:", error);

    res.status(500).json({
      error: "Chat server error.",
      details: error.message
    });

  }

});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `AIWolf server running on port ${PORT}`
  );

  console.log(
    `AIWolf TEST MODE: ${AIWOLF_TEST_MODE}`
  );

  console.log(
    `AIWolf limit: ${AIWOLF_LIMIT} requests / 10 minutes`
  );

  console.log("Firebase Admin: connected");
});
