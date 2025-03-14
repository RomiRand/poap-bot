const Discord = require("discord.js");
const axios = require("axios");
const csv = require("fast-csv");
const pino = require("pino");
const moment = require("moment");
const queryHelper = require("./db");
const pgPromise = require("pg-promise");
const { v4: uuidv4 } = require("uuid");
require('dotenv').config();

const db = pgPromise()({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_DATABASE || "",
});

const dbv2 = (!process.env.DBV2_HOST) ? null : pgPromise()({
  host: process.env.DBV2_HOST,
  user: process.env.DBV2_USER || "postgres",
  password: process.env.DBV2_PASSWORD || "postgres",
  database: process.env.DBV2_DATABASE || "",
});

const logger = pino({
  prettyPrint: {
    colorize: true, // --colorize
    errorLikeObjectKeys: ["err", "error"], // --errorLikeObjectKeys
    levelFirst: false, // --levelFirst
    messageKey: "msg", // --messageKey
    levelKey: "level", // --levelKey
    timestampKey: "time", // --timestampKey
    translateTime: true, // --translateTime
    ignore: "pid,hostname", // --ignore,
  },
});

const states = {
  LISTEN: "listen",
  SETUP: "setup",
  EVENT: "event",
  UPDATE: "update", // could do a more generic UPDATE (not only codes)
};

const steps = {
  NONE: "none",
  SELECT: "select",
  CHANNEL: "channel",
  START: "start",
  END: "end",
  START_MSG: "start_msg",
  END_MSG: "end_msg",
  RESPONSE: "response",
  REACTION: "reaction",
  PASS: "pass",
  FILE: "file",
};

const defaultStartMessage =
  "The POAP distribution event is now active. *DM me to get your POAP*";
const defaultEndMessage = "The POAP distribution event has ended.";
const defaultResponseMessage =
  "Thanks for participating in the event. Here is a link where you can claim your POAP token: {code} ";
const instructions = ":warning: :warning: :warning: :warning: **You MUST send me a DIRECT MESSAGE with the code** :warning: :warning: :warning: :warning:  (click my name)"

var state = {
  state: states.LISTEN,
  expiry: 0,
  user: undefined,
  next: steps.NONE,
  event: {},
};

var guildEvents = new Map();

var start_timeouts = new Map();
var end_timeouts = new Map();

const client = new Discord.Client();

client.on("ready", () => {
  logger.info("[SETUP] Discord client ready!");

  (async () => {
    const res = await db.query("select count(*) from pg_database");
    logger.info(
      `[SETUP] ${res[0].count > 0 ? "PG client ready!" : "PG NOT READY"}`
    );

    await loadPendingEvents();
  })();
});

client.on("message", async (message) => {
  if (message.content === "ping") {
    message.reply("pong");
  } else if (!message.author.bot) {
    if (message.channel.type === "dm") {
      logger.info(
        `[MSG] DM ${message.channel.type} - ${message.content} from ${message.author.username}`
      );

      if ((state.state === states.SETUP || state.state === states.UPDATE) && state.user.id === message.author.id) {
        logger.info(`[ONMSG] state ${state.state} user ${state.user ? state.user.id : "-"}`);
        await handleStepAnswer(message);
      } else {
        await handlePrivateEventMessage(message);
      }
    } else {
      await handlePublicMessage(message);
    }
  }
});

const sendDM = async (user, message) => {
  return new Promise(async (resolve, reject) => {
    const dm = await user.createDM();
    dm.send(message)
      .then((res) => {
        logger.info(`[DM] perfect, sent!`);
        resolve();
      })
      .catch((error) => {
        logger.error(`[DM] error ${error.httpStatus} - ${error.message}`);
        reject();
      });
  });
};

//-------------------------------
// Message handling

const handlePublicMessage = async (message) => {
  // logger.info(
  //   `[PUBMSG] ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`
  // );

  const bot = client.user;

  if (message.mentions.has(bot)) {
    if (
      message.content.includes("@everyone") ||
      message.content.includes("@here")
    )
      return "";
    logger.info(`[PUBMSG] ${message.author.username} - Message mentions me with: ${message.content}`);
    botCommands(message);
  }
};

const botCommands = async (message) => {
  // let allowedRole = message.guild.roles.cache.find(x => x.name === 'POAP MASTER')
  const roleAllowed = message.member.roles.cache.some(r=>["POAP MASTER"].includes(r.name))
  logger.info(`[BOT] checking role ${roleAllowed}`);
  if (message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD) || roleAllowed) {
    // Check that user is an admin in this guild
    logger.info(`[BOT] user has permission`);
    if (message.content.toLowerCase().includes("!setup") && state.state === states.LISTEN) {
      // one at a time
      // Get any current record for this guild
      // start dialog in PM
      await setupState(message.author, message.channel.guild.name);
    } else if (message.content.includes("!status")) {
      logger.info(`[BOT] status request`);
      // sendDM(message.author, `Current status: ${state.state}`);
      const events = await queryHelper.getGuildEvents(
        db,
        message.channel.guild.name
      ); // Don't auto-create
      if (events && events.length > 0) {
        events.forEach(async (e) =>
          sendDM(message.author, `${await formattedEvent(e)}`)
        );
        reactMessage(message, "🙌");
      }
    } else if (message.content.includes("!instructions") || message.content.includes("!instruction"))
    {
      logger.info(`[BOT] instructions request`);

      reactMessage(message, "🤙")
      message.reply(instructions);
    } else if (message.content.includes("!update") && state.state === states.LISTEN) {
      await setupUpdate(message.author, message.channel.guild.name);
    }
  }
  else {
    logger.info(`[BOT] user lacks permission, or invalid command`);
    // reactMessage(message, "❗");
  }
};

const handleStepAnswer = async (message) => {
  resetExpiry();
  let answer = message.content;
  switch (state.next) {
    case steps.SELECT: {
      const event = await queryHelper.getAnyEventByCode(db, answer);
      if (!event)
      {
        //... TODO handle v2?
        state.dm.send(`Unknown codeword, try again`);
        return;
      }
      state.event = event
      state.event.uuid = event.id
      state.next = steps.CHANNEL
      state.dm.send(
          `First: which channel should I speak in public? (${
              state.event.channel || ""
          }) *Hint: only for start and end event`
      );
    }
    break;
    case steps.CHANNEL: {
      logger.info(`[STEPS] answer ${state.event.id}`);
      if (answer === "-") answer = state.event.channel;
      if (answer && answer.startsWith("#")) answer = answer.substring(1);
      // Confirm that channel exists
      const chan = await getChannel(state.event.server, answer);
      if (!chan) {
        const channels = printChannels(state.event.server)
        state.dm.send(
          `I can't find a channel named ${answer}. Try again -> ${channels}`
        );
      } else {
        state.event.channel = answer;
        state.next = steps.START;

        state.dm.send(
          `Date and time to START 🛫 ? *Hint: Time in UTC this format 👉  yyyy-mm-dd hh:mm (` +
          `${state.event.start_date && moment(state.event.start_date).format("YYYY-MM-DD HH:mm") || 
          moment().utc().format("YYYY-MM-DD HH:mm")})`
        );
      }
      break;
    }
    case steps.START: {
      // TODO vali-date validate date :p
      if (answer === "-") answer = state.event.start_date || moment.utc();
      if(!moment(answer).isValid()){
        state.dm.send(
          `mmmm ${answer} It's a valid date? Try again 🙏`
        );
      } else {
        state.event.start_date = moment.utc(answer);
        state.next = steps.END;
        state.dm.send(
          `Date and time to END 🛬  the event? (${
            state.event.end_date && moment(state.event.end_date).format("YYYY-MM-DD HH:mm") ||
            (state.event.start_date.isValid() && moment.utc(state.event.start_date) // need to create a copy here, we don't want to modify the start!
              .add(1, "h")
              .format("YYYY-MM-DD HH:mm"))
          })`
        );
      }
      break;
    }
    case steps.END: {
      if (answer === "-")
        answer = state.event.end_date ||
          moment.utc(state.event.start_date)
          .add(1, "h")
          .format("YYYY-MM-DD HH:mm");
      
      state.event.end_date = moment.utc(answer);
      state.next = steps.RESPONSE;
      state.dm.send(
        `Response to send privately to members during the event? (${
          state.event.response_message || defaultResponseMessage
        })`
      );
      break;
    }
    case steps.RESPONSE: {
      if (answer === "-")
        answer = state.event.response_message || defaultResponseMessage;
      state.event.response_message = answer;
      state.next = steps.PASS;
      state.dm.send(
        `Choose secret 🔒 pass (like a word, a hash from youtube or a complete link). This pass is for your users.` +
        `${state.event.pass && " (" + state.event.pass + ")" || ""}`
      );
      break;
    }
    case steps.PASS: {
      if (answer === "-")
        answer = state.event.pass;
      else {
        const passAvailable = await queryHelper.isPassAvailable(db, answer);
        console.log(passAvailable);
        if (!passAvailable) {
          state.dm.send(`Please choose another secret pass. Try again 🙏 `);
          return;
        }
      }
      state.event.pass = answer;
      //const emoji = getEmoji(state.event.server, answer);
      logger.info(`[STEPS] pass to get the POAP ${answer}`);

      state.next = steps.FILE;
      state.dm.send(`Please attach your links.txt file${state.event.file_url && " (" + state.event.file_url + ")" || ""}`);
      break;
    }
    case steps.FILE: {
      if (answer !== "-") {
        await handleCodeFile(message);
      }
      state.next = steps.NONE;
      state.dm.send(
        `Thank you. That's everything. I'll start the event at the appointed time.`
      );
      if (state.state === states.SETUP) {
        await queryHelper
            .saveEvent(db, state.event, message.author.username)
            .catch((error) => {
              console.log(error);
            });
      }
      else if (state.state === states.UPDATE)
      {
        await queryHelper
            .updateEvent(db, state.event)
            .catch((error) => {
              console.log(error);
            });
      }
      // Set timer for event start
      startEventTimer(state.event);
      clearSetup();
      break;
    }
  }
};

const handlePrivateEventMessage = async (message) => {
  // console.log(message);
  logger.info(`[DM] msg: ${message.content}`);

  const userIsBanned = await isBanned(db, message.author.id);

  if (!userIsBanned) {
    // 1) check if pass is correct and return an event
    const event = await queryHelper.getEventFromPass(db, message.content);
    console.log(event);
    if (event) {
      const getCode = await queryHelper.checkCodeForEventUsername(
        db,
        event.id,
        message.author.id
      );

      getCode.code && logger.info(`[DM] Code found: ${getCode.code}`);

      if (getCode.code) {
        logger.info(
          `[DM] OK for ${message.author.username}/${message.author.id} with code: ${getCode.code}`
        );

        console.log(
          "[DEBBUG] DM",
          JSON.stringify(message.author),
          " CODE: ",
          getCode.code
        );

        // replace placeholder in message
        const replyMsg =
          event && event.response_message
            ? event.response_message.replace("{code}", getCode.code)
            : defaultResponseMessage.replace("{code}", getCode.code);

        // Send DM
        replyMessage(message, replyMsg);
      }
      else
      {
        replyMessage(message, getCode)
        // reactMessage(message, "🤔");
        logger.info(
          `[DM] ${message}/${message.author.id}: ${getCode}`
        );
      }
    } else {
      const codev2 = await checkPassInNewBot(message);
      if(codev2) {
        replyMessage(message, codev2);
      } else {
        // no events
        replyMessage(message, "Unknown codeword");
      }
    }
  } else {
    // bannedUser, no answer
    logger.info(
      `[BANNEDUSER] DM ${message.author.username}/${message.author.id}`
    );
  }
};

const checkPassInNewBot = async (message) => {
  if(!dbv2){
    logger.error(`No .env variable defined for v2`);
    return null;
  }
  const eventPass = message.content.replace('!', '').replace(/ /g, "");
  try{
    const event = await queryHelper.v2.getEventByPass(dbv2, eventPass);
    if(!event){
      return null;
    }

    const activeEvent = await queryHelper.v2.getActiveEventByPass(dbv2, eventPass);
    if(!activeEvent) {
      return "Event is no longer active";
    }

    const claimedCode = await queryHelper.v2.checkCodeForEventUsername(dbv2, event.id,message.author.id);
    if(!claimedCode)
      return "There are no more codes available";

    logger.info(
        `[DM-V2] OK for ${message.author.username}/${message.author.id} with code from new bot v2: ${claimedCode}`
    );

    console.log(
        "[DEBUG] DM-V2",
        JSON.stringify(message.author),
        " CODE: ",
        claimedCode
    );

    // replace placeholder in message
    return event && event.response_message
        ? event.response_message.replace("{code}", claimedCode)
        : defaultResponseMessage.replace("{code}", claimedCode);
  }catch (e){
    logger.error(`[DM-V2] error with DM, ${e}`);
    return null;
  }
};

const isBanned = async (db, user_id) => {
  const isBanned = await queryHelper.getBannedUsersById(db, user_id);
  return isBanned;
};

//-------------------------------------------
// Setup

// Initialise the state for a setup dialog
const setupState = async (user, guild) => {
  logger.info(`[SETUP] setupState ${guild}`);
  state.state = states.SETUP;
  state.next = steps.CHANNEL;
  state.event = getGuildEvent(guild); // Will create one if not already
  logger.info(`[SETUP] created or got event ${JSON.stringify(state.event)}`);
  state.dm = await user.createDM();
  state.dm.send(
    `Hi ${user.username}! You want to set me up for an event in ${guild}? I'll ask for the details, one at a time.`
  );
  state.dm.send(`To accept the suggested value, respond with "-"`);
  state.dm.send(
    `First: which channel should I speak in public? (${
      state.event.channel || ""
    }) *Hint: only for start and end event`
  );
  state.event.uuid = uuidv4();
  state.user = user;
  resetExpiry();
};

const setupUpdate = async (user, guild) => {
  logger.info(`[BOT] update request`);
  const events = await queryHelper.getAllGuildEvents(
      db,
      guild
  );
  if (!events) {
    // error
    logger.info(`[BOT] error getting events for guild ${guild}`)
    return;
  }
  if (events.length === 0)
  {
    sendDM(user, `No events in server ${guild}`);
    return;
  }
  state.dm = await user.createDM();
  state.state = states.UPDATE;
  state.user = user;
  state.dm.send(`Okay, let's update your event! I'll take you through the same dialog you already know and love.` +
      ` On each step you can enter '-' to keep your old setting.`);
  if (events.length > 1) {
    state.next = steps.SELECT;
    let event_codes = [];
    events.forEach(async (event) => {event_codes.push(event["pass"])});
    state.dm.send(`Which event do you want to update? Enter the corresponding codeword (\`${event_codes.join("\`, \`")}\`)`);
  }
  else {
    // we can skip codeword selection step if there's only one
    state.event = events[0]
    state.event.uuid = state.event.id
    state.next = steps.CHANNEL;
    // state.dm.send(`Please attach your new links.txt file. It should only contain new codes!`);
    state.dm.send(
        `First: which channel should I speak in public? (${
            state.event.channel || ""
        }) *Hint: only for start and end event`
    );
  }
  resetExpiry();
};

const resetExpiry = () => {
  console.log('setting reset')
  if (state.state !== states.LISTEN) {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => {
      if (!state.dm)
      {
        console.log("error");
      }
      else {
        state.dm.send(
            `Setup expired before answers received. Start again if you wish to complete setup.`
        );
      }
      clearSetup();
    }, 300000);
  }
};

const clearSetup = () => {
  logger.info(`[SETUP] Clearing setup. Event in ${state.event.server} `);
  state.state = states.LISTEN;
  state.dm = undefined;
  state.event = {};
  state.user = undefined;
  state.next = steps.NONE;
  if (state.expiry)
    clearTimeout(state.expiry);
};

// ---------------------------------------------------------------------
// Event

const startEventTimer = (event) => {
  // get seconds until event start
  const millisecs = getMillisecsUntil(event.start_date);
  if (millisecs >= 0) {
    logger.info(
      `[TIMER] Event starting at ${event.start_date}, in ${
        millisecs / 1000
      } secs`
    );
    // set timeout. Call startEvent on timeout
    if (start_timeouts.has(event.uuid)) {
      clearTimeout(start_timeouts.get(event.uuid));
      logger.info("Replacing start event for " + event.pass);
      start_timeouts.delete(event.uuid);
    }
    start_timeouts.set(event.uuid, setTimeout((ev) => startEvent(ev), millisecs, event));
  }
};

const startEvent = async (event) => {
  start_timeouts.delete(event.uuid);
  logger.info(`[EVENT] started: ${JSON.stringify(event.server)}`);
  // Send the start message to the channel
  sendMessageToChannel(event.server, event.channel, defaultStartMessage);

  // Set timer for event end
  const millisecs = getMillisecsUntil(event.end_date);
  logger.info(`[EVENT] ending in ${millisecs / 1000} secs`);
  if (end_timeouts.has(event.uuid)) {
    clearTimeout(end_timeouts.get(event.uuid));
    logger.info("Replacing end event for " + event.pass);
    end_timeouts.delete(event.uuid);
  }
  end_timeouts.set(event.uuid, setTimeout((ev) => endEvent(ev), millisecs, event));
};

const getMillisecsUntil = (time) => {
  // return Date.parse(time) - new Date();
  return moment.utc(time).diff(moment.utc());
};

const endEvent = async (event) => {
  end_timeouts.delete(event.uuid);
  logger.info(`[EVENT] ended: ${JSON.stringify(event)}`);
  state.state = states.LISTEN;
  // send the event end message
  sendMessageToChannel(event.server, event.channel, defaultEndMessage);
};

const formattedEvent = async (event) => {
  if (!event || !event.server) return "";

  let ms = getMillisecsUntil(event.start_date);
  let pending = `Event will start in ${ms / 1000} seconds`;
  if (ms < 0) {
    ms = getMillisecsUntil(event.end_date);
    if (ms < 0) {
      pending = "Event finished";
    } else {
      pending = `Event will end in ${ms / 1000} seconds`;
    }
  }

  const totalCodes = await queryHelper.countTotalCodes(db, event.id);
  const claimedCodes = await queryHelper.countClaimedCodes(db, event.id);

  return `Event in guild: ${event.server}
    Channel: ${event.channel}
    Start: ${moment.utc(event.start_date)}
    End: ${moment.utc(event.end_date)}
    Event start message: ${defaultStartMessage}
    Event end message: ${defaultEndMessage}
    Response to member messages: ${event.response_message}
    Pass to get the code: ${event.pass}
    Codes url: ${event.file_url}
    Total Codes: ${totalCodes && totalCodes.count}
    Claimed Codes: ${claimedCodes && claimedCodes.count}
    ${pending}`;
};

const getGuildEvent = (guild, autoCreate = true) => {
  if (!guildEvents.has(guild)) {
    if (!autoCreate) return false;
    guildEvents.set(guild, {
      server: guild,
    });
  }
  return guildEvents.get(guild);
};

//-----------------------------------------------
// Discord functions

const sendMessageToChannel = async (guildName, channelName, message) => {
  logger.info(
    `[CHANNELMSG] sendMessageToChannel ${guildName} ${channelName} msg ${message}`
  );
  const channel = getChannel(guildName, channelName);
  if (!channel) {
    return;
  }
  await channel.send(message);
};

const getChannel = (guildName, channelName) => {
  const guild = getGuild(guildName);
  if (!guild) {
    return false;
  }
  const channel = guild.channels.cache.find(
    (chan) => chan.name === channelName
  );
  if (!channel) {
    logger.info(
      `[CHANNELMSG] Channel not found! Guild channels: ${guild.channels.cache.size}`
    );
    return false;
  }
  return channel;
};

const printChannels = (guildName) => {
  const guild = getGuild(guildName);
  if (!guild) {
    return false;
  }
  const channels = guild.channels.cache.map( chan => `${chan},` ).join(' ');
  return channels;
};

const getGuild = (guildName) => {
  const guild = client.guilds.cache.find((guild) => guild.name === guildName);
  if (!guild) {
    logger.info(`[GUILD] not found! Client guilds: ${client.guilds.cache}`);
    return false;
  }
  return guild;
};

const replyMessage = async (message, sendMessage) => {
  message
    .reply(sendMessage)
    .catch((error) =>
      logger.error(`[DM] error with DM ${error.httpStatus} - ${error.message}`)
    );
};

const reactMessage = async (message, reaction) => {
  message
    .react(reaction)
    .catch((error) =>
      logger.error(
        `[EVENTMSG] error with reaction ${error.httpStatus} - ${error.message}`
      )
    );
};

//-------------------------------------------------------------------------------------------------

const loadPendingEvents = async () => {
  // read all events that will start or end in the future.
  // TODO add end-timers for already started events
  try {
    let res = await queryHelper.getFutureActiveEvents(db);
    // console.log(res)
    res &&
      logger.info(`[PG] Active events: ${JSON.stringify(res && res.length)}`);
    if (res && res.length > 0) {
      // start timer for each one.
      res.forEach(async (row) => {
        logger.info(
          `Active event: ${row.id} | ${row.start_date} - ${row.end_date}`
        );
        startEventTimer(row);
      });
    } else {
      logger.info("[PG] No pending events");
    }
  } catch (err) {
    logger.error(`[PG] Error while getting event: ${err}`);
  }
};


const handleCodeFile = async (message) => {
  if (message.attachments.size <= 0) {
    state.dm.send(`No file attachment found!`);
  } else {
    const ma = message.attachments.first();
    logger.info(`[STEPS] File ${ma.name} ${ma.url} ${ma.id} is attached`);
    if (state.event.file_url)
      state.event.file_url += ", " + ma.url;
    else
      state.event.file_url = ma.url;
    let codes = await readFile(ma.url, state.event.uuid);
    let duplicates = []
    for (const code of codes) {
      let res = await queryHelper.addCode(db, state.event.uuid, code)
      if (res != null)
      {
        duplicates.push(code);
      }
    }
    // Report number of codes added
    state.dm.send(`DONE! ${codes.length - duplicates.length} codes added`);
    if (duplicates.length > 0)
    {
      state.dm.send(`${duplicates.length} duplicates detected`);
    }
    if (duplicates.length === codes.length)
    {
      state.dm.send(`Send another file!`);
    }
    return codes.length - duplicates.length;
  }
}


const readFile = async (url) => {
  return new Promise(async (resolve, reject) => {
    let data = [];
    try {
      const res = await axios.get(url);
      await csv
        .parseString(res.data, { headers: false })
        .on("data", async function (code) {
          if (code.length > 0)
            data.push(code[0]);
        })
        .on("end", function () {
          logger.info(`[CODES] read file`);
          resolve(data);
        })
        .on("error", (error) => logger.error(error));
    } catch (err) {
      logger.error(`[CODES] Error reading file: ${err}`);
    }
  });
};

//-------------------------------------------------------------------------------------------
// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
