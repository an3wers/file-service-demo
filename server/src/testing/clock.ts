/**
 * Общие управляемые часы тестовых реализаций.
 *
 * База ставит время на строках, хранилище — на открытых загрузках,
 * а уборка проверяет их возраст. В рабочем окружении они используют
 * одно время; изменение только одних часов в тесте создало бы
 * нереальный сценарий. Поэтому всем передаются одни часы,
 * а `advance` превращает свежее резервирование в просроченное.
 */
export interface TestClock {
  now(): Date;
  /** Передвигает часы вперёд, сохраняя уже полученные отметки времени. */
  advance(hours: number): void;
}

const HOUR_MS = 60 * 60 * 1000;

export function createTestClock(start: Date = new Date()): TestClock {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (hours) => {
      current += hours * HOUR_MS;
    },
  };
}
