import { api } from "encore.dev/api";
import {  info, trace, error } from "encore.dev/log";
import { IBundler, Bundler } from "@biconomy/bundler";
import axios from 'axios';
import { ethers } from "ethers";
import { Wallet, providers } from "ethers";
import {
    BiconomySmartAccount,
    BiconomySmartAccountConfig,
    DEFAULT_ENTRYPOINT_ADDRESS,
} from "@biconomy/account";
import {
    BiconomyPaymaster,
    IHybridPaymaster,
    PaymasterMode,
    SponsorUserOperationDto,
} from "@biconomy/paymaster";
import { ChainId } from "@biconomy/core-types";
import * as crypto from 'crypto';
const { ERC20ABI } = require('./abi')
import { SQLDatabase } from "encore.dev/storage/sqldb";
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import OpenAI from "openai";

const OPENAI_API_KEY = '';

const db = new SQLDatabase("keys", {
    migrations: "./migrations",
});

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;

function encrypt(text: string): string {
    let iv = crypto.randomBytes(IV_LENGTH);
    // @ts-ignore
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift() as string, 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    // @ts-ignore
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

async function findByPhone(phone: string): Promise<string | undefined> {
    const row = await db.query`SELECT key FROM keys WHERE phone = ${phone}`;
    if (row) {
        // @ts-ignore
        return decrypt(row[0].key);
    }
    return undefined;
}

async function insertKey(phone: string, key: string): Promise<void> {
    let id = uuidv4();
    let encryptedKey = encrypt(key);
    await db.exec`
      INSERT INTO keys (uuid, key, phone)
      VALUES (${id}, ${encryptedKey}, ${phone})
    `;
}


interface ClassificationResponse {
    action: 'send_money' | 'request_payment' | 'get_balance';
    to: string,
    amount: string
}


function generatePrivateKey(): string {
    const privateKey = crypto.randomBytes(32).toString('hex');
    return "0x" + privateKey;

}

async function createAccount(from: string) {
    let pk = await findByPhone(from)
    if ( pk == '') {
        pk = generatePrivateKey()
        insertKey(from, pk)
    }

    const bundler: IBundler = new Bundler({
        bundlerUrl:
            "https://bundler.biconomy.io/api/v2/10/",
        chainId: ChainId.OPTIMISM_MAINNET,
        entryPointAddress: DEFAULT_ENTRYPOINT_ADDRESS,
    });

    const provider = new providers.JsonRpcProvider(
        "https://rpc.ankr.com/optimism"
    );

    // @ts-ignore
    const wallet = new Wallet( pk, provider);

    const paymaster = new BiconomyPaymaster({
        paymasterUrl: "https://paymaster.biconomy.io/api/v1/10/"
    });

    const biconomySmartAccountConfig: BiconomySmartAccountConfig = {
        signer: wallet,
        paymaster: paymaster,
        chainId: ChainId.OPTIMISM_MAINNET,
        bundler: bundler,
    };
    let biconomySmartAccount = new BiconomySmartAccount(
        biconomySmartAccountConfig
    );

    biconomySmartAccount = await biconomySmartAccount.init();
    return biconomySmartAccount;
}

async function sendMoney( from: string, to: string, amount: string) {
    let biconomySmartAccount = await createAccount(from)
    let tokenAddress = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'

    const readProvider = new ethers.providers.JsonRpcProvider("https://rpc.ankr.com/optimism")
    const tokenContract = new ethers.Contract(tokenAddress, ERC20ABI, readProvider)
    let decimals = 18

    try {
        decimals = await tokenContract.decimals()
    } catch (error) {
        throw new Error('invalid token address supplied')
    }

    console.log("3")
    const amountGwei = ethers.utils.parseUnits(amount, decimals)
    const data = (await tokenContract.populateTransaction.transfer(tokenAddress, amountGwei)).data
    const transaction = {
        to: to,
        data,
    };

    let partialUserOp = await biconomySmartAccount.buildUserOp([transaction]);

    let finalUserOp = partialUserOp;

    const biconomyPaymaster = biconomySmartAccount.paymaster as IHybridPaymaster<SponsorUserOperationDto>;
    let paymasterServiceData: SponsorUserOperationDto = {
        mode: PaymasterMode.SPONSORED,
    };

    try{
        const paymasterAndDataWithLimits =
            await biconomyPaymaster.getPaymasterAndData(
                finalUserOp,
                paymasterServiceData
            );
        finalUserOp.paymasterAndData = paymasterAndDataWithLimits.paymasterAndData;
        if (
            paymasterAndDataWithLimits.callGasLimit &&
            paymasterAndDataWithLimits.verificationGasLimit &&
            paymasterAndDataWithLimits.preVerificationGas
        ) {
            finalUserOp.callGasLimit = paymasterAndDataWithLimits.callGasLimit;
            finalUserOp.verificationGasLimit =
                paymasterAndDataWithLimits.verificationGasLimit;
            finalUserOp.preVerificationGas =
                paymasterAndDataWithLimits.preVerificationGas;
        }
    } catch (e) {
        console.log("error received here ", e);
    }

    console.log(`userOp: ${JSON.stringify(finalUserOp, null, "\t")}`);

    try {
        const userOpResponse = await biconomySmartAccount.sendUserOp(finalUserOp);
        console.log(`userOp Hash: ${userOpResponse.userOpHash}`);
        const transactionDetails = await userOpResponse.wait();
        console.log(
            `transactionDetails: ${JSON.stringify(transactionDetails, null, "\t")}`
        );
        return userOpResponse.userOpHash
        } catch (e) {
        console.log("error received ", e);
    }

}

async function sendMessage(content: string, from: string) {
    const url = process.env.URL;
    const headers = {
        'Content-Type': 'application/json',
    };
    const body = {
        "chatId": from,
        "contentType": "string",
        "content": content,
    };

    try {
        // @ts-ignore
        const response = await axios.post(url, body, { headers: headers });
        console.log(response.data);

    } catch (error) {
        console.error('Error:', error);
    };
}

async function classifyInput(input: string): Promise<ClassificationResponse> {
    try {
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
        let prompt = `you need to clasify the follwoing text: ${input} into only one of those 3 categories: send_money, request_payment or get_balance. please only response as a json with action key in case of request_payment, return to param and amount as string in the json`
        console.log(prompt)
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-instruct',
            messages: [{ role: "assistant", content: prompt }],
            max_tokens: 500,
            n: 1,
            stop: null,
            temperature: 0.5,
        });
        // @ts-ignore
        return { action: response.choices.action, amount: response.choices.amount, to: response.choices.to};
    } catch (error) {
        console.error('Error classifying input:', error);
        throw error;
    }
}

interface Data {
    dataType: string;
    data: any
}

export const webhook = api(
    { expose: true, method: "POST", path: "/whatsapp" },
    async (params: Data): Promise<Response> => {
        if (params.dataType == "message") {
            info("params", params);
            try {
                let option = await classifyInput(params.data.message.body)

                // @ts-ignore
                if ( option.action == "send_money") {
                    let hash = await sendMoney(params.data.message.from, option.to, option.amount)
                    await sendMessage(`${hash}`, params.data.message.from);
                } else { // @ts-ignore
                    if (option.action == "balance") {
                                        let aa =  await createAccount(params.data.message.from)
                                        let balance = await aa.getTotalBalanceInUsd({
                                            chainId: ChainId.OPTIMISM_MAINNET, address: "", tokenAddresses: []
                                        })
                        await sendMessage(`${balance.message}`, params.data.message.from);
                                    }
                }
                return { success: true };
            } catch (error) {
                return { success: true };
            }
        }
        return { success: true };
    }
);




interface Response {
    success: boolean;
}
