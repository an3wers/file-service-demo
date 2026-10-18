/**
 * Позволяет тестовым реализациям однократно воспроизвести отказ зависимости.
 *
 * При обычной работе они хранят состояние. Этот переключатель позволяет
 * дополнительно проверить недоступность хранилища или отказ таблицы:
 * следующий вызов указанного метода выбрасывает заданную ошибку.
 *
 * Отказ срабатывает один раз, чтобы последующие действия по откату
 * могли завершиться успешно.
 */
export interface FailureSwitch<M extends string> {
  /** Выбрасывает подготовленную ошибку для выбранного метода и сбрасывает её. */
  check(method: M): void;

  /** Отклоняет следующий вызов этого метода для проверки обработки ошибок. */
  failNext(method: M, error: unknown): void;
}

export function createFailureSwitch<M extends string>(): FailureSwitch<M> {
  const armed = new Map<M, unknown>();

  return {
    check(method: M): void {
      if (!armed.has(method)) {
        return;
      }

      const error = armed.get(method);

      armed.delete(method);
      throw error;
    },

    failNext(method: M, error: unknown): void {
      armed.set(method, error);
    },
  };
}
