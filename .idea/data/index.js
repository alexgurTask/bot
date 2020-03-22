const nforce = require('nforce');
const helper = require('./helper');
const config = require('./config');
const session = require('telegraf/session');
const Telegraf = require('telegraf');
const Markup = require('telegraf/markup');
const Calendar = require('telegraf-calendar-telegram');
const Stage = require('telegraf/stage');
const Scene = require('telegraf/scenes/base');
const { leave } = Stage;
const stage = new Stage();
const userLogin = new Scene('userLogin');
const userPassword = new Scene('userPassword');
const mainMenu = new Scene('mainMenu');
const subMenu = new Scene('subMenu');
const forDate = new Scene('forDate');
const expenseCardDesc = new Scene('expenseCardDesc');
const newExpenseCard = new Scene('newExpenseCard');


const bot = new Telegraf(config.bot.TOKEN, {webhookReply: false});

let port = process.env.PORT || config.http || config.https,
    state = {},
    conectOrgSF = helper.conectOrg;

conectOrgSF.authenticate({ username: config.salesforce.SFUSER, password: config.salesforce.SFPASS}, function(err, resp){
    if(!err) {
        console.log('Success connection');
    } else {
        console.log('Error: ' + err.message);
    }
});
userLogin.enter(async (ctx) => {
    return ctx.reply(`Введите логин: `);
});
userLogin.on('text', (ctx) => {
    state[ctx.from.id] = { id : ctx.from.id };
    state[ctx.from.id].login = ctx.message.text;
    ctx.scene.enter('userPassword');
});
userPassword.enter((ctx) => {
    return ctx.reply(`Введите пароль: `);
});
userPassword.on('text', async (ctx) => {
    state[ctx.from.id].password = ctx.message.text;
    let query = `SELECT Id, Name, Email FROM Contact 
                    WHERE Email = '${state[ctx.from.id].login}' AND Password__c = '${state[ctx.from.id].password}'`;
    conectOrgSF.query({ query: query }, async (err, resp) => {
        if (!err && resp.records.length != 0) {
            let contact = JSON.parse(JSON.stringify(resp.records[0]));
            state[ctx.from.id].contactId = contact.id;
            state[ctx.from.id].name = contact.name;
            return ctx.reply(`Авторизация успешна!`)
                .then(() => ctx.scene.enter('mainMenu'));
        } else {
            return ctx.reply('Неверный логин или пароль!!!')
                .then(() => ctx.scene.enter('userLogin'));
        }
    });
});
mainMenu.enter(async (ctx) => {
    return ctx.reply(`Выберите действия!`,
        Markup.inlineKeyboard([
            Markup.callbackButton(`Баланс`,  `Balance`),
            Markup.callbackButton(`Создать карточку`, `Card`)
        ]).extra());
});
mainMenu.on('callback_query', async (ctx) => {
    let button = ctx.callbackQuery.data;
    switch (button) {
        case 'Balance':
            let current_date = new Date();
            let query = `SELECT Id, Month_Date__c, Spent_Amount__c, Balance__c, Keeper__c 
                            FROM Monthly_Expense__c 
                            WHERE CALENDAR_YEAR(Month_Date__c) = ${current_date.getFullYear()} AND Keeper__c ='${state[ctx.from.id].contactId}'`;

            conectOrgSF.query({ query: query }, async (err, resp) => {
                // console.log(resp)
                let income = 0;
                let amount = 0;
                let listMonthlyExpenses = JSON.parse(JSON.stringify(resp.records));
                listMonthlyExpenses.forEach(function(monthlyExpense) {
                    console.log(monthlyExpense)
                    income += monthlyExpense.balance__c;
                    amount += monthlyExpense.spent_amount__c;
                });
                console.log(income)
                console.log(amount)
                return ctx.reply(`Ваш баланс: $ ${(income - amount).toFixed(2)}.`)
                    .then(() => ctx.scene.enter('mainMenu'));
            });
            break;
        case 'Card':
            state[ctx.from.id].newevent = 'Expense Card';
            ctx.scene.enter('subMenu');
            break;
    }
});
forDate.enter(async (ctx) => {
    const calendar = new Calendar(bot, {
        startWeekDay: 0,
        weekDayNames: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
        monthNames: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'],
        minDate: new Date(2019, 0, 1),
        maxDate: new Date()
    });
    calendar.setDateListener(async (ctx, date) => {
        state[ctx.from.id].date = new Date(date);
        state[ctx.from.id].newevent == 'Expense Card', ctx.scene.enter('expenseCardDesc');
    });
    return ctx.reply(`Выберите дату:`, calendar.getCalendar());
});
subMenu.enter(async (ctx) => {
    return ctx.reply(`На какой день хотите создать карточку:`,
        Markup.inlineKeyboard([
            Markup.callbackButton(`Сегодня`,  `Today`),
            Markup.callbackButton(`Календарь`, `Date`),
            Markup.callbackButton(`Отмена`, `Back`)
        ]).extra());
});
subMenu.on('callback_query', async (ctx) => {
    let button = ctx.callbackQuery.data;
    switch (button) {
        case 'Today':
            state[ctx.from.id].date = new Date();
            state[ctx.from.id].newevent == 'Expense Card',ctx.scene.enter('expenseCardDesc');
            break;
        case 'Date':
            ctx.scene.enter('forDate');
            break;
        case 'Back':
            ctx.scene.enter('mainMenu');
            break;
    }
});

expenseCardDesc.enter(async (ctx) => {
    return ctx.reply(`Введите описание карточки:`);
});
expenseCardDesc.on('message', (ctx) => {
    state[ctx.from.id].description = ctx.message.text;
    ctx.scene.enter('newExpenseCard');
});

newExpenseCard.enter(async (ctx) => {
    return ctx.reply(`Введите стоимость этой карточки:`);
});
newExpenseCard.hears(/^\d*([.,]\d*)?$/, async (ctx) => {
    let amount = parseFloat(ctx.message.text.replace(/,/, '.')).toFixed(2);
    let expenseCard = nforce.createSObject('Expense_Card__c',{
        Card_Date__c: state[ctx.from.id].date,
        Amount__c: amount,
        Description__c: state[ctx.from.id].description,
        Card_Keeper__c: state[ctx.from.id].contactId,
        Name: `${helper.formatDate(state[ctx.from.id].date)}_${state[ctx.from.id].name}`
    });

    conectOrgSF.insert({sobject: expenseCard},async function(err, resp) {
        if (!err) {
            return ctx.reply(`Карта расходов создана!\nДата: ${helper.formatDate(state[ctx.from.id].date)}\n Стоимость: ${amount}\n Описание: ${state[ctx.from.id].description}`)
                .then(() => ctx.scene.enter('mainMenu'));
        } else {
            return ctx.reply('Ошибка: ' + err.message);
        }
    });
});
newExpenseCard.on('message', async (ctx) => {
    return ctx.reply(`Введите стоимость карточки:`);
});

stage.register(userLogin);
stage.register(userPassword);
stage.register(mainMenu);
stage.register(subMenu);
stage.register(forDate);
stage.register(expenseCardDesc);
stage.register(newExpenseCard);

stage.command('start', async (ctx) => {
    leave();
    return ctx.scene.enter('userLogin');
});

bot.telegram.setWebhook(`${config.heroku.URL}/bot${config.bot.TOKEN}`);
bot.startWebhook(`/bot${config.bot.TOKEN}`, null, port);
bot.use(session());
bot.use(stage.middleware());
bot.start(async (ctx) => {
    return ctx.scene.enter('userLogin');
});
bot.catch((err, ctx) => {
    console.log(`Ошибка по причине ${ctx.updateType}`, err)
});
async function startup() {
    await bot.launch();
    console.log(new Date(), 'Bot started', bot.options.username);
};
startup();
setInterval(helper.getHttps, 900000);