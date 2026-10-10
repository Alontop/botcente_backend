import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import {
  CHATBOT_SYSTEM_PROMPT,
  CORRECCION_TAREAS_PROMPT,
} from "./src/prompts/systemPrompts.js";
import { upload } from "./src/middlewares/upload.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODELOS_CADENA = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
];

async function solicitarGemini(contents, systemInstruction) {
  let ultimoError = null;

  for (const modelo of MODELOS_CADENA) {
    const maxIntentosPorModelo = 3;

    for (let intento = 1; intento <= maxIntentosPorModelo; intento++) {
      try {
        console.log(
          `[Intento ${intento}/${maxIntentosPorModelo}] Consultando modelo: ${modelo}...`,
        );

        const response = await ai.models.generateContent({
          model: modelo,
          contents: contents,
          config: { systemInstruction },
        });

        console.log(`¡Éxito en la respuesta con el modelo ${modelo}!`);
        return response.text;
      } catch (error) {
        ultimoError = error;
        console.warn(
          `Error (${error.status || "desconocido"}) en modelo ${modelo}: ${error.message}`,
        );

        if (
          error.status === 400 ||
          error.status === 404 ||
          error.status === 429
        ) {
          console.log(`Saltando modelo ${modelo} por error ${error.status}...`);
          break;
        }

        if (error.status === 503 && intento < maxIntentosPorModelo) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          break;
        }
      }
    }
  }

  throw new Error(
    `Ningún modelo estuvo disponible. Último error: ${ultimoError?.message}`,
  );
}

function mapearHistorialAGemini(historial = []) {
  const result = [];

  historial.forEach((item) => {
    const role = item.emisor === "usuario" ? "user" : "model";
    const parts = [];

    if (item.imagenBase64 && item.mimeType) {
      parts.push({
        inlineData: {
          data: item.imagenBase64,
          mimeType: item.mimeType,
        },
      });
    }

    if (item.texto) {
      parts.push({ text: item.texto });
    } else if (parts.length === 0) {
      parts.push({ text: "" });
    }

    if (result.length > 0 && result[result.length - 1].role === role) {
      result[result.length - 1].parts.push(...parts);
    } else {
      result.push({ role, parts });
    }
  });

  return result;
}

function obtenerUltimaImagenDelHistorial(historial = []) {
  for (let i = historial.length - 1; i >= 0; i--) {
    if (historial[i].imagenBase64 && historial[i].mimeType) {
      return {
        data: historial[i].imagenBase64,
        mimeType: historial[i].mimeType,
      };
    }
  }
  return null;
}

app.post("/api/chatbot", async (req, res) => {
  try {
    const { mensaje, historial = [] } = req.body;

    if (!mensaje && historial.length === 0) {
      return res
        .status(400)
        .json({ error: "El mensaje o historial es obligatorio" });
    }

    const contents = mapearHistorialAGemini(historial);

    if (mensaje) {
      if (
        contents.length > 0 &&
        contents[contents.length - 1].role === "user"
      ) {
        contents[contents.length - 1].parts.push({ text: mensaje });
      } else {
        contents.push({
          role: "user",
          parts: [{ text: mensaje }],
        });
      }
    }

    const respuestaText = await solicitarGemini(
      contents,
      CHATBOT_SYSTEM_PROMPT,
    );
    return res.json({ respuesta: respuestaText });
  } catch (error) {
    console.error("Error en Chatbot:", error);
    return res.status(500).json({
      error: "Ocurrió un error al procesar la solicitud con la IA.",
      detalle: error.message,
    });
  }
});

app.post("/api/evaluar-tarea", upload.single("archivo"), async (req, res) => {
  try {
    const { textoEstudiante, historial } = req.body;
    const archivo = req.file;

    let historialParseado = [];
    if (historial) {
      try {
        historialParseado = JSON.parse(historial);
      } catch (e) {
        console.warn("No se pudo parsear el historial recibido.");
      }
    }

    let contents = mapearHistorialAGemini(historialParseado);

    if (!textoEstudiante && !archivo && contents.length === 0) {
      return res.status(400).json({
        error: "Debes enviar un mensaje, historial o adjuntar un archivo.",
      });
    }

    const partsActuales = [];

    if (archivo) {
      if (archivo.mimetype === "application/pdf") {
        partsActuales.push({
          inlineData: {
            data: archivo.buffer.toString("base64"),
            mimeType: "application/pdf",
          },
        });
      } else if (archivo.mimetype.startsWith("image/")) {
        partsActuales.push({
          inlineData: {
            data: archivo.buffer.toString("base64"),
            mimeType: archivo.mimetype,
          },
        });
      }
    } else {
      const ultimaImagen = obtenerUltimaImagenDelHistorial(historialParseado);
      if (ultimaImagen) {
        partsActuales.push({
          inlineData: {
            data: ultimaImagen.data,
            mimeType: ultimaImagen.mimeType,
          },
        });
      }
    }

    const instruccionModo = `
[MODO DE RESPUESTA]:
- Observa la imagen/PDF adjunto.
- SI LA FICHA CONTIENE RESPUESTAS/DESARROLLO ESCRITO: Revisa toda la ficha de inmediato, señala los aciertos/errores y brinda la nota final.
- SI LA FICHA ESTÁ VACÍA O SIN RESPONDER: NO des todas las soluciones de golpe. Sigue las instrucciones del Prompt de Sistema para explicar con paciencia y guiando PASO A PASO únicamente sobre el primer ejercicio.
`;

    const mensajeUsuario = textoEstudiante
      ? `Mensaje del estudiante: "${textoEstudiante}"`
      : "";
    const promptFinal = `${instruccionModo}\n${mensajeUsuario}`;

    partsActuales.push({ text: promptFinal });

    if (contents.length > 0 && contents[contents.length - 1].role === "user") {
      contents[contents.length - 1].parts.push(...partsActuales);
    } else {
      contents.push({
        role: "user",
        parts: partsActuales,
      });
    }

    const respuestaText = await solicitarGemini(
      contents,
      CORRECCION_TAREAS_PROMPT,
    );

    return res.json({ respuesta: respuestaText });
  } catch (error) {
    console.error("Error en Evaluar Tarea:", error);
    return res.status(500).json({
      error: "Ocurrió un error al evaluar la tarea con la IA.",
      detalle: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Botcente ejecutándose en el puerto ${PORT}`);
});
