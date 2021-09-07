const functions = require('firebase-functions');
const firebaseAdmin = require('firebase-admin');
const { WebClient } = require('@slack/web-api');

const config = require('./config');

const environment = functions.config();

const db = firebaseAdmin.firestore();

const { token } = environment.slack;
const web = new WebClient(token);

const slackMessageHelp = {
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Invalid command! :wave: Need some help with `/okr`?',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Slug is the lowercase name your organization/department/product gets and is used in the url. I.E: https://okr.oslo.systems/oslo-origo. The slug here is `oslo-origo`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Subscribe to notifications for an organization\n`/okr subscribe organization organization-slug`\nExample: `/okr subscribe organization oslo-origo`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Unsubscribe to notifications for an organization\n`/okr unsubscribe organization organization-slug`\nExample: `/okr unsubscribe organization oslo-origo`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Subscribe to notifications for a department\n`/okr subscribe department department-slug`\nExample: `/okr subscribe department apen-by`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Unsubscribe to notifications for a department\n`/okr subscribe dep department-slug`\nExample: `/okr unsubscribe dep apen-by`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Subscribe to notifications for a product\n`/okr subscribe product product-slug`\nExample: `/okr subscribe product oslonokkelen`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Unsubscribe to notifications for a product\n`/okr subscribe product product-slug`\nExample: `/okr unsubscribe product oslonokkelen`',
      },
    },
  ],
};

const allowedSub = ['product', 'department', 'organization'];
const allowedDeepSub = ['organization', 'department'];

const departmentCollection = db.collection('departments');
const organizationCollection = db.collection('organizations');

exports.okrTrackerSlackBot = functions
  .runWith(config.runtimeOpts)
  .region(config.region)
  .https.onRequest(async (req, res) => {
    const slackCollection = db.collection('slack');

    if (!req.body.text) {
      return res.status(200).send(slackMessageHelp);
    }

    const subcommands = req.body.text.split(' ');

    console.log(subcommands);

    // If user sends subscribe
    if (subcommands[0] === 'subscribe' && allowedSub.includes(subcommands[1])) {
      // Check if user wants to subscribe to everything from top to bottom of org/dep
      // Get the document and check if it exists
      const collection = await db.collection(`${subcommands[1]}s`).where('slug', '==', subcommands[2]).get();
      if (collection.docs.length === 0 || !collection.docs[0].exists) {
        return res
          .status(200)
          .send(`Could not find the ${subcommands[1]}, are you sure you've typed in the correct name?`);
      }

      // Get the slack document
      const slackDoc = await slackCollection.doc(subcommands[2]).get();

      // If it doesnt exist, then add a new document with the information
      if (!slackDoc.exists) {
        await addChannelToDoc(slackCollection, subcommands[1], subcommands[2], req.body.channel_id, false);
      } else {
        const result = await updateChannelsToDoc(
          slackDoc,
          slackCollection,
          req.body.channel_id,
          subcommands[2],
          false,
          res
        );
        if (!result) {
          return res.status(200).send(`You have already subscribed to ${subcommands[2]} in this channel`);
        }
      }

      await postToSlack(subcommands[2], req.body.channel_id, req.body.channel_name);

      return res.status(200).send();
    }
    if (subcommands[0] === 'unsubscribe' && allowedSub.includes(subcommands[1])) {
      // TODO: check if it has a deep connection, if it does then say that you need to run unsubscribe/all

      const collection = await db.collection(`${subcommands[1]}s`).where('slug', '==', subcommands[2]).get();
      if (collection.docs.length === 0 || !collection.docs[0].exists) {
        return res
          .status(200)
          .send(`Could not find the ${subcommands[1]}, are you sure you've typed in the correct name?`);
      }

      // Get the slack document
      const slackDoc = await slackCollection.doc(subcommands[2]).get();

      // If it doesnt exist, then add a new document with the information
      if (!slackDoc.exists) {
        return res.status(200).send(`No subscription found for ${subcommands[1]}?`);
      }

      const doc = slackDoc.data();

      const channelExists = inChannels(req.body.channel_id, doc.channels);
      if (!channelExists) {
        return res.status(200).send('You do not have a subscription');
      }

      doc.channels = doc.channels.filter((channel) => channel.channel !== req.body.channel_id);

      await slackCollection.doc(subcommands[2]).update({
        channels: doc.channels,
      });

      const result = await web.chat.postMessage({
        text: `You have successfully unsubscribed to ${subcommands[2]}`,
        channel: req.body.channel_id,
      });

      console.log(`Successfully send message ${result.ts} in conversation ${req.body.channel_name}`);

      return res.status(200).send();
    }

    if (subcommands[0] === 'subscribe/all' && allowedDeepSub.includes(subcommands[1])) {
      const collection = await db.collection(`${subcommands[1]}s`).where('slug', '==', subcommands[2]).get();
      if (collection.docs.length === 0 || !collection.docs[0].exists) {
        return res
          .status(200)
          .send(`Could not find the ${subcommands[1]}, are you sure you've typed in the correct name?`);
      }
      const orgId = collection.docs[0].id;

      if (subcommands[1] === 'organization') {
        const { slackPromises, depsAndProds } = await getAllDepsAndProds(orgId, slackCollection);

        const slackResult = await Promise.all(slackPromises);

        const promises = await updateChannelsFromDoc(slackResult, depsAndProds, slackCollection, req.body.channel_id);

        await Promise.all(promises);
      } else if (subcommands[1] === 'department') {
        const { slackPromises, allProducts } = await getAllProductss(orgId, slackCollection);

        const slackResult = await Promise.all(slackPromises);

        const promises = await updateChannelsFromDoc(slackResult, allProducts, slackCollection, req.body.channel_id);

        await Promise.all(promises);
      } else {
        return res.status(200).send('You can only run subscribe/all on a department or organization');
      }

      // Get the slack document
      const slackDoc = await slackCollection.doc(subcommands[2]).get();

      // If it doesnt exist, then add a new document with the information
      if (!slackDoc.exists) {
        await addChannelToDoc(slackCollection, subcommands[1], subcommands[2], req.body.channel_id, true);
      } else {
        const result = await updateChannelsToDoc(
          slackDoc,
          slackCollection,
          req.body.channel_id,
          subcommands[2],
          true,
          res
        );
        if (!result) {
          return res.status(200).send(`You have already subscribed to ${subcommands[2]} in this channel`);
        }
      }

      await postToSlack(subcommands[2], req.body.channel_id, req.body.channel_name);

      return res.status(200).send();
    }

    if (subcommands[0] === 'unsubscribe/all' && allowedDeepSub.includes(subcommands[1])) {
      const collection = await db.collection(`${subcommands[1]}s`).where('slug', '==', subcommands[2]).get();
      if (collection.docs.length === 0 || !collection.docs[0].exists) {
        return res
          .status(200)
          .send(`Could not find the ${subcommands[1]}, are you sure you've typed in the correct name?`);
      }
      const orgId = collection.docs[0].id;

      // Get the slack document
      const slackDoc = await slackCollection.doc(subcommands[2]).get();

      // If it doesnt exist, then add a new document with the information
      if (!slackDoc.exists) {
        return res.status(200).send(`No subscription found for ${subcommands[1]}?`);
      }

      const doc = slackDoc.data();
      let hasDeep = false;

      for (let i = 0; i < doc.channels.length; i += 1) {
        if (doc.channels[i].channel === req.body.channel_id && doc.channels[i].deep === true) {
          hasDeep = true;
          break;
        }
      }

      if (!hasDeep) {
        return res.status(200).send(`You do not subscribe to everything for ${subcommands[2]}`);
      }

      if (subcommands[1] === 'organization') {
        const { slackPromises, depsAndProds } = await getAllDepsAndProds(orgId, slackCollection);

        const slackResult = await Promise.all(slackPromises);

        const promises = await filterOutChannelsFromDoc(
          slackResult,
          depsAndProds,
          slackCollection,
          req.body.channel_id
        );

        await Promise.all(promises);
      } else if (subcommands[1] === 'department') {
        const { slackPromises, allProducts } = await getAllProductss(orgId, slackCollection);

        const slackResult = await Promise.all(slackPromises);

        const promises = await filterOutChannelsFromDoc(slackResult, allProducts, slackCollection, req.body.channel_id);

        await Promise.all(promises);
      } else {
        return res.status(200).send('You can only run subscribe/all on a department or organization');
      }

      doc.channels = doc.channels.filter((channel) => channel.channel !== req.body.channel_id);

      await slackCollection.doc(subcommands[2]).update({
        channels: doc.channels,
      });

      const result = await web.chat.postMessage({
        text: `You have successfully unsubscribed to ${subcommands[2]}`,
        channel: req.body.channel_id,
      });

      console.log(`Successfully send message ${result.ts} in conversation ${req.body.channel_name}`);

      return res.status(200).send();
    }

    return res.status(200).send(slackMessageHelp);
  });

const inChannels = (channelId, arr) => {
  let channelExists = false;
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i].channel === channelId) {
      channelExists = true;
      break;
    }
  }
  return channelExists;
};

const postToSlack = async (document, channelId, channelName) => {
  const result = await web.chat.postMessage({
    text: `You have successfully subscribed to ${document}`,
    channel: channelId,
  });

  console.log(`Successfully send message ${result.ts} in conversation ${channelName}`);
};

const addChannelToDoc = (collection, type, name, channelId, deep) =>
  collection.doc(name).set({
    type: `${type}s`,
    name,
    channels: [{ channel: channelId, deep }],
  });

const updateChannelsToDoc = async (slackDoc, slackCollection, channelId, name, deep) => {
  const doc = slackDoc.data();
  // Run through array and check if the channel exists
  const channelExists = inChannels(channelId, doc.channels);
  if (channelExists) {
    return false;
  }

  // Push new channel to array and update the document
  doc.channels.push({ channel: channelId, deep });
  await slackCollection.doc(name).update({
    channels: doc.channels,
  });
  return true;
};

const getAllDepsAndProds = async (orgId, slackCollection) => {
  const deps = await db.collection('departments').where('organization', '==', organizationCollection.doc(orgId)).get();
  const prods = await db.collection('products').where('organization', '==', organizationCollection.doc(orgId)).get();

  const slackPromises = [];
  const depsAndProds = [];
  deps.docs.forEach((dep) => {
    const data = dep.data();
    depsAndProds.push(data);
    slackPromises.push(slackCollection.doc(data.slug).get());
  });
  prods.docs.forEach((prod) => {
    const data = prod.data();
    depsAndProds.push(data);
    slackPromises.push(slackCollection.doc(data.slug).get());
  });

  return { slackPromises, depsAndProds };
};

const getAllProductss = async (orgId, slackCollection) => {
  const prods = await db.collection('products').where('department', '==', departmentCollection.doc(orgId)).get();

  const slackPromises = [];
  const allProducts = [];
  prods.docs.forEach((prod) => {
    const data = prod.data();
    allProducts.push(data);
    slackPromises.push(slackCollection.doc(data.slug).get());
  });

  return { slackPromises, allProducts };
};

const filterOutChannelsFromDoc = async (slackArr, docsArr, slackCollection, channelId) => {
  const promises = [];
  slackArr.forEach((result, index) => {
    const data = result.data();
    if (result.exists) {
      data.channels = data.channels.filter((channel) => channel.channel !== channelId);
      promises.push(
        slackCollection.doc(docsArr[index].slug).update({
          channels: data.channels,
        })
      );
    }
  });

  return promises;
};

const updateChannelsFromDoc = async (slackArr, docsArr, slackCollection, channelId) => {
  const promises = [];
  slackArr.forEach((result, index) => {
    const doc = result.data();
    if (!result.exists) {
      const type = docsArr[index].department ? 'products' : 'departments';
      const name = docsArr[index].slug;
      promises.push(addChannelToDoc(slackCollection, type, name, channelId, false));
    } else {
      doc.channels.push({ channel: channelId, deep: false });
      promises.push(
        slackCollection.doc(docsArr[index].slug).update({
          channels: doc.channels,
        })
      );
    }
  });

  return promises;
};
