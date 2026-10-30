import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { ChatGoogle } from "@langchain/google";
import { tool } from "langchain";
import z from "zod";
import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  START,
  MemorySaver,
  interrupt,
  Command,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";

const MENU = {
  "veg momo": 120,
  "chicken momo": 180,
  "buff momo": 150,
  "jhol momo": 200,
  "tea": 30,
};

const getMenu = tool(
  () => {
    return Object.entries(MENU)
      .map(([name, price]) => `${name}: Rs ${price}`)
      .join("\n");
  },
  {
    name: "get_menu",
    description: "Returns the shop menu with prices. Use it when the customer asks what is available.",
    schema: z.object({}),
  }
);

const calculateBill = tool(
  ({ items }) => {
    let total = 0;

    for (const item of items) {
      const price = MENU[item.name.toLowerCase()];

      if (!price) {
        return `Sorry, "${item.name}" is not on our menu.`;
      }
      total += price * item.qty;
    }

    return `Total bill: Rs ${total}`;
  },
  {
    name: "calculate_bill",
    description: "Calculates the total bill from a list of items and quantities.",
    schema: z.object({
      items: z.array(
        z.object({
          name: z.string().describe("Name of the menu item"),
          qty: z.number().describe("How many plates / cups"),
        })
      ),
    }),
  }
);

const placeOrder = tool(
  ({ items, total }) => {
    const answer = interrupt({
      question: `Do you want to confirm this order of Rs ${total}?`,
      items,
      total,
    });

    if (answer !== "yes") {
      return "The customer cancelled the order.";
    }

    return `Order placed successfully! Total: Rs ${total}. It will be ready in 10 minutes.`;
  },
  {
    name: "place_order",
    description:
      "Places the final order. Only use this after the customer agrees, and after you know the total from calculate_bill.",
    schema: z.object({
      items: z.array(
        z.object({
          name: z.string(),
          qty: z.number(),
        })
      ),
      total: z.number().describe("Total bill amount in Rs"),
    }),
  }
);

const tools = [getMenu, calculateBill, placeOrder];

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  llmCalls: Annotation({
    reducer: (oldValue, newValue) => oldValue + newValue,
    default: () => 0,
  }),
});

const model = new ChatGoogle("gemini-3.5-flash").bindTools(tools);

const SYSTEM_PROMPT = {
  role: "system",
  content: `You are "Momo Dai", a friendly waiter at a momo shop.
- Keep your replies short, warm and polite.
- Use the get_menu tool when the customer asks about the menu.
- Always use calculate_bill to find the total. Never calculate it yourself.
- Before placing an order, tell the customer the total and ask if they want to order.
- Only use place_order after the customer agrees.
- Never sell anything that is not on the menu.`,
};

const agentNode = async (state) => {
  const reply = await model.invoke([SYSTEM_PROMPT, ...state.messages]);

  return {
    messages: [reply],
    llmCalls: 1,
  };
};

const graph = new StateGraph(State)
  .addNode("agent", agentNode)
  .addNode("tools", new ToolNode(tools))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition)
  .addEdge("tools", "agent")
  .compile({ checkpointer: new MemorySaver() });

const buildConfig = (threadId) => ({
  configurable: { thread_id: threadId },
  recursionLimit: 10,
});

const formatResult = (result, threadId) => {
  if (result.__interrupt__) {
    const info = result.__interrupt__[0].value;

    return {
      status: "approval_required",
      threadId,
      message: info.question,
      items: info.items,
      total: info.total,
    };
  }

  return {
    status: "completed",
    threadId,
    reply: result.messages.at(-1).content,
    llmCalls: result.llmCalls,
  };
};

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Momo Dai server is running" });
});

app.post("/chat", async (req, res) => {
  try {
    const { prompt, threadId } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const currentThreadId = threadId || randomUUID();

    const result = await graph.invoke(
      { messages: [{ role: "user", content: prompt }] },
      buildConfig(currentThreadId)
    );

    return res.json(formatResult(result, currentThreadId));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong", details: error.message });
  }
});

app.post("/chat/resume", async (req, res) => {
  try {
    const { threadId, answer } = req.body;

    if (!threadId || !answer) {
      return res.status(400).json({ error: "threadId and answer are required" });
    }

    const result = await graph.invoke(
      new Command({ resume: String(answer).trim().toLowerCase() }),
      buildConfig(threadId)
    );

    return res.json(formatResult(result, threadId));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong", details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Momo Dai server started on port ${port}`);
});