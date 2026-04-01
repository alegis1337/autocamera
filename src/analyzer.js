/**
 * analyzer.js — Vision analysis via polza.ai API (OpenAI-compatible)
 */

import fs from 'fs';
import OpenAI from 'openai';
import * as log from './logger.js';

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.POLZA_API_KEY,
      baseURL: 'https://polza.ai/api/v1',
    });
  }
  return client;
}

const SYSTEM_PROMPTS = {
  ipanda: `Это скриншот системы видеонаблюдения iPanda.
Проанализируй каждую ячейку с камерой и верни JSON.

Признаки статуса:
- online: true  → в ячейке видно видеопоток (изображение с камеры)
- online: false → ячейка чёрная ИЛИ есть текст "Нет соединения"
- recording: true  → в углу ячейки есть красная буква "R"
- recording: false → буквы "R" нет
- audio: true  → в углу ячейки есть красная буква "M"
- audio: false → буквы "M" нет

Верни ТОЛЬКО валидный JSON без markdown-блоков:
{
  "cameras": [
    { "index": 0, "online": true, "recording": true, "audio": false, "notes": "" }
  ],
  "summary": "Краткое описание: сколько онлайн, сколько оффлайн"
}`,

  hiwatch: `Это скриншот системы видеонаблюдения HiWatch (Hikvision).
Проанализируй каждую ячейку с камерой и верни JSON.

Признаки статуса:
- online: true  → в ячейке видно видеопоток с временным штампом
- online: false → в ячейке есть текст "NO VIDEO" (белый текст на тёмном фоне)
- recording: true  → есть индикатор записи в ячейке
- recording: false → индикатора нет

Верни ТОЛЬКО валидный JSON без markdown-блоков:
{
  "cameras": [
    { "index": 0, "online": true, "recording": true, "audio": false, "notes": "" }
  ],
  "summary": "Краткое описание: сколько онлайн, сколько оффлайн"
}`,

  default: `Это скриншот системы видеонаблюдения.
Проанализируй каждую ячейку с камерой.

Признаки:
- online: true если видно видеопоток, false если чёрная ячейка или сообщение об ошибке
- recording: true если есть индикатор записи (REC, R, красная точка)
- audio: true если есть индикатор микрофона/звука

Верни ТОЛЬКО валидный JSON без markdown-блоков:
{
  "cameras": [
    { "index": 0, "online": true, "recording": true, "audio": false, "notes": "" }
  ],
  "summary": "Краткое описание"
}`,
};

/**
 * Analyzes a screenshot and returns structured camera statuses.
 */
export async function analyzeScreenshot(screenshotFilePath, systemType = 'default', systemId = 'unknown') {
  const step = `${systemId}:ai`;

  try {
    const imageBuffer = fs.readFileSync(screenshotFilePath);
    const base64Image = imageBuffer.toString('base64');
    const imageSizeKB = Math.round(imageBuffer.length / 1024);
    const prompt = SYSTEM_PROMPTS[systemType] || SYSTEM_PROMPTS.default;
    const model = process.env.POLZA_MODEL || 'google/gemini-3.1-flash-lite-preview';

    log.stepStart(step, 'Отправка скриншота в AI', { model, imageSize: `${imageSizeKB}KB` });

    const response = await getClient().chat.completions.create({
      model,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    const usage = response.usage;
    log.debug(step, 'Ответ AI получен', {
      tokens_in: usage?.prompt_tokens,
      tokens_out: usage?.completion_tokens,
      response_length: text.length,
    });

    const result = parseAIResponse(text);

    if (result.error) {
      log.stepEnd(step, 'warn', 'AI ответ не парсится как JSON', { error: result.error });
    } else {
      const online = result.cameras.filter(c => c.online === true).length;
      const offline = result.cameras.filter(c => c.online === false).length;
      log.stepEnd(step, 'ok', 'Анализ завершён', {
        cameras: result.cameras.length,
        online,
        offline,
      });

      // Логируем проблемные камеры отдельно
      for (const cam of result.cameras) {
        if (cam.online === false) {
          log.warn(step, `Камера ${cam.index} offline`, { notes: cam.notes || '' });
        }
        if (cam.recording === false) {
          log.warn(step, `Камера ${cam.index} не записывает`, { notes: cam.notes || '' });
        }
      }
    }

    return result;

  } catch (err) {
    log.stepEnd(step, 'fail', 'Ошибка AI запроса', { error: err.message });
    return { cameras: [], summary: '', error: err.message };
  }
}

function parseAIResponse(text) {
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(clean);
    return {
      cameras: parsed.cameras || [],
      summary: parsed.summary || '',
      error: null,
    };
  } catch {
    return {
      cameras: [],
      summary: text.slice(0, 300),
      error: `AI response not valid JSON: ${text.slice(0, 100)}`,
    };
  }
}
