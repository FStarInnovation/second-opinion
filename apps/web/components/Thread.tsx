"use client";
/**
 * Тред чата на примитивах assistant-ui (без shadcn/Tailwind — стиль продукта из @so/blocks).
 * ym-hide-content (поле ввода и реплики пользователя) — Вебвизор Метрики не записывает то, что пишет пользователь.
 */
import type { FC } from "react";
import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from "@assistant-ui/react";
import { TOOL_UIS, ToolFallback } from "./ToolUIs";

const SUGGESTIONS = [
  "Проверь РОЛЬФ 1Р07, обещали 26%",
  "RU000A0JS4Z7 — говорят, 18% годовых",
  "Черкизово",
  "Что такое НКД?",
];

const Text: FC = () => <MessagePrimitive.Parts components={{ Text: TextPart }} />;
const TextPart: FC<{ text: string }> = ({ text }) => <p className="so-msg__text">{text}</p>;

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="so-msg so-msg--user" data-role="user">
    <div className="so-msg__bubble ym-hide-content"><Text /></div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="so-msg so-msg--assistant" data-role="assistant">
    <MessagePrimitive.Parts
      components={{
        Text: TextPart,
        tools: { by_name: TOOL_UIS, Fallback: ToolFallback },
      }}
    />
    <MessagePrimitive.Error>
      <p className="note note--bad">Не получилось ответить. Попробуйте ещё раз.</p>
    </MessagePrimitive.Error>
  </MessagePrimitive.Root>
);

export const Thread: FC<{ mock?: boolean }> = ({ mock }) => (
  <ThreadPrimitive.Root className="so-thread">
    <ThreadPrimitive.Viewport className="so-thread__viewport" autoScroll>
      <ThreadPrimitive.Empty>
        <div className="so-thread__empty">
          <span className="so-title__kind">Ассистент Second opinion</span>
          <h1 className="so-h1">Назовите бумагу — соберу отчёт</h1>
          <p className="text">
            ISIN, название выпуска или эмитента. Можно сразу добавить сумму, комиссию брокера и что обещал продавец.
            Числа — расчёт по данным Мосбиржи; ассистент их объясняет, но не придумывает.
          </p>
          <div className="so-thread__suggestions">
            {SUGGESTIONS.map((s) => (
              <ThreadPrimitive.Suggestion key={s} prompt={s} send asChild>
                <button type="button" className="btn btn-outline">{s}</button>
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        </div>
      </ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      <ThreadPrimitive.ViewportFooter className="so-thread__footer">
        <ComposerPrimitive.Root className="so-composer">
          <ComposerPrimitive.Input
            className="so-composer__input ym-hide-content ym-disable-keys"
            placeholder="Например: проверь RU000A10ASE2, обещали 26%"
            rows={1}
            autoFocus
            submitOnEnter
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="btn btn-primary so-composer__send" aria-label="Отправить">Отправить</ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="btn btn-outline so-composer__send">Стоп</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
        <p className="cap so-thread__disclaimer">Не является индивидуальной инвестиционной рекомендацией. Данные Мосбиржи с задержкой до 15 минут.</p>
        {/* Без строки «модель · маршрутизация»: пользователю она не нужна; бейдж — только в режиме MOCK (разработка, ключей нет) */}
        {mock && <p className="cap so-thread__mock" data-mode="mock">Режим MOCK — расход $0</p>}
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);
