import { DEFAULT_FORM_TITLE, type FormDetail } from '../../entities/form'

// Ленивое создание формы: кнопка «Новая форма» НИЧЕГО не создаёт на сервере, а
// открывает редактор несуществующего черновика. POST /forms уходит с первой правкой
// (useAutosave.ensureForm), и форма, которую открыли и закрыли не тронув, на сервере
// не появляется вовсе.
//
// Адрес такого черновика — /forms/new/edit, тот же маршрут, что и у настоящей формы:
// создание заменяет `new` на реальный slug, НЕ размонтировав полотно (маршрут тот же,
// ключ стора заморожен) — иначе первая же правка выбивала бы каретку из-под автора.
// Столкнуться с настоящим slug сентинел не может: сервер выдаёт ровно
// domain.SlugLen = 10 символов, здесь их три.
export const NEW_FORM_SLUG = 'new'

// Деталь несозданной формы: редактору она нужна вся (гидрирует стор, рисует шапку и
// страницу настроек) за минуту до того, как форма появится. Поля повторяют то, чем
// новую форму заводит сервер, — пустой черновик, дефолтный заголовок, письма о новых
// ответах включены (forms.Create + дефолты колонок `forms`). Врать этому зеркалу
// недолго: с первой правкой деталь заменяется настоящей карточкой из ответа POST.
export function newFormDetail(): FormDetail {
  return {
    id: '',
    name: null,
    title: DEFAULT_FORM_TITLE,
    slug: NEW_FORM_SLUG,
    status: 'draft',
    createdAt: '',
    updatedAt: '',
    publishedVersion: null,
    publishedVersionId: null,
    hasUnpublishedChanges: false,
    submissionCount: 0,
    visitCount: 0,
    visitSubmittedCount: 0,
    draftSchema: { blocks: [] },
    closeAt: null,
    responseLimit: null,
    closedMessage: null,
    notifyOnSubmission: true,
  }
}
