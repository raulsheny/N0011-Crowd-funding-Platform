'use strict';

var path = require('path');
var fs = require('fs');
var util = require('util');

var hfc = require('fabric-client');
var utils = require('fabric-client/lib/utils.js');
var Peer = require('fabric-client/lib/Peer.js');
var EventHub = require('fabric-client/lib/EventHub.js');

var config = require('../config.json')
var helper = require('./helper.js');
var logger = helper.getLogger('instantiate-chaincode');

hfc.addConfigFile(path.join(__dirname, 'network-config.json'));
var ORGS = hfc.getConfigSetting('network-config');

var tx_id = null;
var nonce = null;
var adminUser = null;
var eventhubs = [];
var allEventhubs = [];
var isSuccess = null;

var instantiateChaincode = function (peers, channelName, chaincodeName, chaincodePath, chaincodeVersion, functionName, args, username, org){

	var closeConnections = function(isSuccess) {
		for(var key in allEventhubs) {
			var eventhub = allEventhubs[key];
			if (eventhub && eventhub.isconnected()) {
				//logger.debug('Disconnecting the event hub');
				eventhub.disconnect();
			}
		}
	}

	    logger.debug('\n============ Instantiate chaincode on organization '+org+' ============\n')
			helper.setupChaincodeDeploy();
			var chain = helper.getChainForOrg(org);
			helper.setupOrderer();
			var targets = helper.getTargets(peers, org);
			helper.setupPeers(chain, peers, targets);

      //FIXME: chanfe this to read peer dynamically
			let eh = new EventHub();
			eh.setPeerAddr(
				ORGS[org]['peer1']['events']
			);
			eh.connect();
			eventhubs.push(eh);
			allEventhubs.push(eh);

	return helper.getRegisteredUsers(username, org)
	.then((member) => {
	  adminUser = member;
		// read the config block from the orderer for the chain
		// and initialize the verify MSPs based on the participating
		// organizations
		return chain.initialize();
	}, (err) => {
		logger.error('Failed to enroll user \'admin\'. ' + err);
		throw new Error('Failed to enroll user \'admin\'. ' + err);

	}).then((success) => {
		nonce = utils.getNonce();
		tx_id = chain.buildTransactionID(nonce, adminUser);

		// send proposal to endorser
		var request = {
			targets: targets,
			chaincodePath: chaincodePath,
			chaincodeId: chaincodeName,
			chaincodeVersion: chaincodeVersion,
			fcn: functionName,
			args: helper.getArgs(args),
			chainId: channelName,
			txId: tx_id,
			nonce: nonce
		};
		return chain.sendInstantiateProposal(request);

	}, (err) => {

		logger.error('Failed to initialize the chain');
		throw new Error('Failed to initialize the chain');

	}).then((results) => {

		var proposalResponses = results[0];

		var proposal = results[1];
		var header   = results[2];
		var all_good = true;
		for(var i in proposalResponses) {
			let one_good = false;
			if (proposalResponses && proposalResponses[0].response && proposalResponses[0].response.status === 200) {
				one_good = true;
				logger.info('instantiate proposal was good');
			} else {
				logger.error('instantiate proposal was bad');
			}
			all_good = all_good & one_good;
		}
		if (all_good) {
			logger.info(util.format('Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s", metadata - "%s", endorsement signature: %s', proposalResponses[0].response.status, proposalResponses[0].response.message, proposalResponses[0].response.payload, proposalResponses[0].endorsement.signature));
			var request = {
				proposalResponses: proposalResponses,
				proposal: proposal,
				header: header
			};

			// set the transaction listener and set a timeout of 30sec
			// if the transaction did not get committed within the timeout period,
			// fail the test
			var deployId = tx_id.toString();

			var eventPromises = [];
			eventhubs.forEach((eh) => {
				let txPromise = new Promise((resolve, reject) => {
					let handle = setTimeout(reject, 30000);

					eh.registerTxEvent(deployId.toString(), (tx, code) => {
						logger.info('The chaincode instantiate transaction has been committed on peer '+ eh.ep._endpoint.addr);
						clearTimeout(handle);
						eh.unregisterTxEvent(deployId);

						if (code !== 'VALID') {
							logger.error('The chaincode instantiate transaction was invalid, code = ' + code);
							reject();
						} else {
							logger.info('The chaincode instantiate transaction was valid.');
							resolve();
						}
					});
				});
				eventPromises.push(txPromise);
			});

			var sendPromise = chain.sendTransaction(request);
			return Promise.all([sendPromise].concat(eventPromises))
			.then((results) => {
				logger.debug('Event promise all complete and testing complete');
				return results[0]; // the first returned value is from the 'sendPromise' which is from the 'sendTransaction()' call
			}).catch((err) => {
				logger.error('Failed to send instantiate transaction and get notifications within the timeout period.');
				return 'Failed to send instantiate transaction and get notifications within the timeout period.';
			});
		} else {
			logger.error('Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...');
			return 'Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...';
		}
	}, (err) => {
		logger.error('Failed to send instantiate proposal due to error: ' + err.stack ? err.stack : err);
		return 'Failed to send instantiate proposal due to error: ' + err.stack ? err.stack : err;
	}).then((response) => {
		if (response.status === 'SUCCESS') {
			logger.info('Successfully sent transaction to the orderer.');
			return 'Chaincode Instantiateion is SUCCESS';
		} else {
			logger.error('Failed to order the transaction. Error code: ' + response.status);
			return 'Failed to order the transaction. Error code: ' + response.status;
		}
	}, (err) => {
		logger.error('Failed to send instantiate due to error: ' + err.stack ? err.stack : err);
		return 'Failed to send instantiate due to error: ' + err.stack ? err.stack : err;
	});
}

exports.instantiateChaincode = instantiateChaincode;
