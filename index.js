// -------------------------------------------------------------
// 🚀 API SALEH DIGITAL
// -------------------------------------------------------------
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// -------------------------------------------------------------
// 🔥 Firebase Admin
// -------------------------------------------------------------
try {
  const jsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const projectId = process.env.GCLOUD_PROJECT;

  const tempPath = path.join(os.tmpdir(), "firebase_key.json");
  fs.writeFileSync(tempPath, jsonString);

  admin.initializeApp({
    credential: admin.credential.cert(require(tempPath)),
    projectId
  });

  console.log("✅ Firebase conectado (Saleh Digital)");
} catch (err) {
  console.error("Firebase ERROR:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// -------------------------------------------------------------
// 🧂 PRODUTOS / ESTOQUE
// -------------------------------------------------------------

// Criar produto (insumo)
app.post("/products", async (req, res) => {
  try {
    const {
      description,
      unit,
      unitSize,
      unitPrice,
      yieldPercent = 100,
      notes = "",
      location = "",
      previousQuantity = 0,
      purchaseQuantity = 0,
      currentQuantity = 0
    } = req.body;

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("products").add({
      description,
      unit,
      unitSize,
      unitPrice,
      yieldPercent,
      notes,
      location,
      previousQuantity,
      purchaseQuantity,
      currentQuantity,
      createdAt: now,
      updatedAt: now
    });

    res.status(201).json({ id: docRef.id, message: "Produto criado" });
  } catch (err) {
    console.error("Erro /products POST:", err);
    res.status(500).json({ error: "Erro ao criar produto" });
  }
});

// Listar produtos
app.get("/products", async (req, res) => {
  try {
    const snap = await db.collection("products").orderBy("description").get();
    const products = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json(products);
  } catch (err) {
    console.error("Erro /products GET:", err);
    res.status(500).json({ error: "Erro ao listar produtos" });
  }
});

// Registrar compra de um produto (atualiza histórico e estoque)
app.post("/products/:id/purchase", async (req, res) => {
  try {
    const productId = req.params.id;
    const { quantity, totalPrice, purchaseDate } = req.body; // quantity na unidade do produto

    const productRef = db.collection("products").doc(productId);
    const productSnap = await productRef.get();

    if (!productSnap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const product = productSnap.data();
    const previousQuantity = product.currentQuantity || 0;
    const currentQuantity = previousQuantity + quantity;

    const unitPrice = totalPrice / quantity;
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Adiciona no histórico
    const purchaseRef = await productRef.collection("purchases").add({
      purchaseDate, // string "YYYY-MM-DD"
      quantity,
      totalPrice,
      unitPrice,
      createdAt: now
    });

    // Atualiza produto
    await productRef.update({
      previousQuantity,
      purchaseQuantity: quantity,
      currentQuantity,
      unitPrice,
      updatedAt: now
    });

    res.status(201).json({
      purchaseId: purchaseRef.id,
      message: "Compra registrada com sucesso"
    });
  } catch (err) {
    console.error("Erro /products/:id/purchase POST:", err);
    res.status(500).json({ error: "Erro ao registrar compra" });
  }
});

// 📜 Histórico de compras de um produto
app.get("/products/:id/history", async (req, res) => {
  try {
    const id = req.params.id;
    const productRef = db.collection("products").doc(id);

    // Aqui eu assumo que na rota /purchase você salvou em "purchases"
    const historySnap = await productRef
      .collection("purchases")
      .orderBy("purchaseDate", "desc")
      .get();

    const history = historySnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(history);
  } catch (err) {
    console.error("Erro em GET /products/:id/history", err);
    res.status(500).json({ error: "Erro ao buscar histórico" });
  }
});


// Histórico de compras + média das últimas 4
app.get("/products/:id/history", async (req, res) => {
  try {
    const productId = req.params.id;
    const productRef = db.collection("products").doc(productId);

    const productSnap = await productRef.get();
    if (!productSnap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const purchasesSnap = await productRef
      .collection("purchases")
      .orderBy("purchaseDate", "desc")
      .get();

    const purchases = purchasesSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const last4 = purchases.slice(0, 4);
    let avgUnitPrice = null;
    if (last4.length > 0) {
      const sum = last4.reduce((acc, p) => acc + (p.unitPrice || 0), 0);
      avgUnitPrice = sum / last4.length;
    }

    res.json({
      product: { id: productId, ...productSnap.data() },
      purchases,
      averageLast4UnitPrice: avgUnitPrice
    });
  } catch (err) {
    console.error("Erro /products/:id/history GET:", err);
    res.status(500).json({ error: "Erro ao buscar histórico" });
  }
});

// 🔄 Atualizar um produto (ex: corrigir descrição)
app.patch("/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    const docRef = db.collection("products").doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    // Só atualiza os campos que vierem no body
    const camposPermitidos = [
      "description",
      "unit",
      "unitSize",
      "unitPrice",
      "yieldPercent",
      "notes",
      "location"
    ];

    const updateData = {};
    camposPermitidos.forEach((campo) => {
      if (body[campo] !== undefined) {
        updateData[campo] = body[campo];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar" });
    }

    await docRef.update(updateData);

    const updated = await docRef.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    console.error("Erro em PATCH /products/:id", err);
    res.status(500).json({ error: "Erro ao atualizar produto" });
  }
});


// -------------------------------------------------------------
// 🍽️ PEDIDOS (GARÇOM / COZINHA / NICOCHAT)
// -------------------------------------------------------------

// Criar novo pedido
app.post("/orders", async (req, res) => {
  try {
    const {
      tableNumber,
      customerName,
      channel,
      items,
      notes = ""
    } = req.body;

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("orders").add({
      tableNumber,
      customerName,
      channel,           // "garcom" | "nicochat" | "app"
      status: "pendente",
      items,
      notes,
      createdAt: now,
      updatedAt: now
    });

    res.status(201).json({ id: docRef.id, message: "Pedido criado" });
  } catch (err) {
    console.error("Erro /orders POST:", err);
    res.status(500).json({ error: "Erro ao criar pedido" });
  }
});

// Listar pedidos por status (versão simples, sem índice)
app.get("/orders", async (req, res) => {
  try {
    const status = req.query.status || "pendente";

    // Tira o orderBy para não precisar de índice composto
    const snap = await db
      .collection("orders")
      .where("status", "==", status)
      .get();

    const orders = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(orders);
  } catch (err) {
    console.error("Erro /orders GET:", err);
    res.status(500).json({ error: "Erro ao listar pedidos" });
  }
});


// Consultar status de um pedido
app.get("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const snap = await db.collection("orders").doc(orderId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("Erro /orders/:id GET:", err);
    res.status(500).json({ error: "Erro ao buscar pedido" });
  }
});

// -------------------------------------------------------------
// 🚀 Rota raiz
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Saleh Digital API está no ar ✅");
});

app.listen(PORT, () => {
  console.log(`🔥 Saleh Digital API rodando na porta ${PORT}`);
});
