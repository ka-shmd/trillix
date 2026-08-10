-- Откат: снять три ключа со всех планов. Возврат к состоянию, в котором каталог
-- о них ещё не знает; на коде этой версии такой план краснел бы
-- TestPlansCoverCatalog — как и задумано, откат данных идёт вместе с откатом кода.
UPDATE plans
SET limits = limits - 'form_design_custom' - 'form_custom_css' - 'form_branding';
