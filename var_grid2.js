// BTC 50单滑动窗口网格自动下单系统 - 完整优化版（2025最新）
class BTCAutoTrading {
    // ========== 基础交易配置 ==========
    static TRADING_CONFIG = {
        START_PRICE: 80000,
        END_PRICE: 100000,
        MIN_ORDER_INTERVAL: 10000,     // 下单最小间隔10秒（防风控）
        ORDER_COOLDOWN: 1000,          // 单个订单成功后冷却3秒
        MONITOR_INTERVAL: 10000,       // 主循环检查间隔（建议8~15秒）
        MAX_PROCESSED_ORDERS: 100,
        POSITION_CHECK_DELAY: 5000,
        MAX_POSITION_CHECKS: 60,
        UI_OPERATION_DELAY: 500,
        PRICE_UPDATE_DELAY: 10000,
        ORDER_SUBMIT_DELAY: 10000,
    };

    // ========== 网格策略核心配置（全部集中在这里调参！）==========
    static GRID_STRATEGY_CONFIG = {
        TOTAL_ORDERS: 8,               // 固定50单滑动窗口

        // 窗口宽度（核心参数！建议 0.08~0.18）
        WINDOW_PERCENT: 0.12,           // 12% → 7万时 ≈ ±4200美元范围

        // 买卖单比例（总和必须为1，可根据牛熊调整）
        SELL_RATIO: 0.5,               // 55% ≈ 27~28个卖单（适合震荡偏多）
        BUY_RATIO:  0.5,               // 45% ≈ 22~23个买单

        // 网格间距
        BASE_PRICE_INTERVAL: 30,        // 基础间距（会自动微调保证填满单数）
        SAFE_GAP: 20,                   // 比当前盘口再偏移一点，防止瞬成

        // 安全保护
        MAX_DRIFT_BUFFER: 2000,         // 超出窗口太多自动停止扩展
        MIN_VALID_PRICE: 10000,         // 防止崩盘挂到地板价
    };

    // ========== 页面元素选择器 ==========
    static SELECTORS = {
        ASK_PRICE: 'span[data-testid="ask-price-display"]',
        BID_PRICE: 'span[data-testid="bid-price-display"]',
        QUANTITY_INPUT: 'input[data-testid="quantity-input"]',
        PRICE_INPUT: 'input[data-testid="limit-price-input"]',
        SUBMIT_BUTTON: 'button[data-testid="submit-button"]',
        ORDERS_TABLE_ROW: '[data-testid="orders-table-row"]',
        RED_ELEMENTS: '.text-red',
        GREEN_ELEMENTS: '.text-green',
        TEXT_CURRENT: '[class*="text-current"]'
    };

    // ========== 文本与类名匹配 ==========
    static TEXT_MATCH = {
        PENDING_ORDERS: ['未成交订单', 'Pending Orders', 'Open Orders'],
        LIMIT_BUTTON: ['限价', 'limit'],
        BUY_BUTTON: ['买', 'Buy'],
        SELL_BUTTON: ['卖', 'Sell']
    };

    static CLASS_MATCH = {
        LIMIT_BUTTON: ['p-0', 'text-center'],
        BUY_BUTTON: 'bg-green',
        SELL_BUTTON: 'bg-red'
    };

    constructor() {
        this.orderManager = new BTCOrderManager();
        this.isMonitoring = false;
        this.monitorInterval = null;
        this.tradingEnabled = false;
        this.processedOrders = new Set();
        this.lastOrderTime = 0;
        this.cycleCount = 0;
        this.isPrepared = false;

        this.minOrderInterval = BTCAutoTrading.TRADING_CONFIG.MIN_ORDER_INTERVAL;
    }

    // ==================== 准备交易环境 ====================
    async prepareTradingEnvironment() {
        console.log('开始准备交易环境...');

        try {
            // 1. 点击“未成交订单”
            const pendingTab = this.findPendingOrdersTab();
            if (pendingTab) {
                pendingTab.click();
                await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);
            }

            // 2. 点击“限价”
            await this.clickLimitButton();
            await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY * 2);

            // 3. 等待仓位设置
            await this.checkAndWaitForPositionSize();

            this.isPrepared = true;
            console.log('交易环境准备完成');
            return true;
        } catch (err) {
            console.error('交易环境准备失败:', err);
            return false;
        }
    }

    findPendingOrdersTab() {
        return Array.from(document.querySelectorAll('span')).find(el =>
            BTCAutoTrading.TEXT_MATCH.PENDING_ORDERS.some(t => el.textContent.includes(t))
        );
    }

    async clickLimitButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        const limitBtn = buttons.find(btn =>
            BTCAutoTrading.TEXT_MATCH.LIMIT_BUTTON.some(t =>
                btn.textContent.toLowerCase().includes(t.toLowerCase())
            )
        ) || buttons.find(btn =>
            BTCAutoTrading.CLASS_MATCH.LIMIT_BUTTON.every(c => btn.className.includes(c))
        );

        if (limitBtn) {
            limitBtn.click();
            await this.delay(BTCAutoTrading.TRADING_CONFIG.UI_OPERATION_DELAY);
            return true;
        }
        console.log('未找到限价按钮，继续...');
        return false;
    }

    async checkAndWaitForPositionSize() {
        let checks = 0;
        while (checks < BTCAutoTrading.TRADING_CONFIG.MAX_POSITION_CHECKS) {
            const input = document.querySelector(BTCAutoTrading.SELECTORS.QUANTITY_INPUT);
            if (input && parseFloat(input.value) > 0) {
                console.log(`仓位已设置: ${input.value}`);
                return true;
            }
            checks++;
            await this.delay(BTCAutoTrading.TRADING_CONFIG.POSITION_CHECK_DELAY);
        }
        console.error('超时：请先手动设置仓位数量！');
        this.showWarningMessage('请先在数量框输入下单张数！');
        return false;
    }

    // ==================== 主控方法 ====================
    async startAutoTrading(interval = BTCAutoTrading.TRADING_CONFIG.MONITOR_INTERVAL) {
        if (this.isMonitoring) return console.log('已在运行');

        const ready = await this.prepareTradingEnvironment();
        if (!ready) return console.error('环境准备失败，无法启动');

        this.isMonitoring = true;
        this.tradingEnabled = true;
        this.cycleCount = 0;
        console.log('BTC 50单网格自动交易已启动');

        // 改用递归的setTimeout确保不重叠
        const executeWithInterval = async () => {
            if (!this.isMonitoring) return;
            
            const startTime = Date.now();
            await this.executeTradingCycle();
            const endTime = Date.now();
            const executionTime = endTime - startTime;
            
            // 计算下一次执行的延迟
            const nextDelay = Math.max(interval - executionTime, 1000); // 最少等待1秒
            console.log(`周期执行耗时: ${executionTime}ms, 下次执行: ${nextDelay}ms后`);
            
            if (this.isMonitoring) {
                setTimeout(executeWithInterval, nextDelay);
            }
        };
        
        // 立即开始第一个周期
        executeWithInterval();
    }

    stopAutoTrading() {
        this.isMonitoring = false;
        this.tradingEnabled = false;
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;
        console.log('自动交易已停止');
    }

    // ==================== 核心交易周期 ====================
    async executeTradingCycle() {
        if (!this.tradingEnabled) return;

        this.cycleCount++;
        console.log(`\n[${new Date().toLocaleTimeString()}] 第${this.cycleCount}次检查`);
        const ready = await this.prepareTradingEnvironment();
        if (!ready) return console.error('环境异常');
        try {
            const marketData = await this.getCompleteMarketData();
            if (!marketData.askPrice || !marketData.bidPrice) {
                console.log('无法读取价格，跳过');
                return;
            }

            const result = this.calculateTargetPrices(marketData);
            console.log('计算订单结果：',result);

            if (result.buyPrices.length > 0 || result.sellPrices.length > 0) {
                this.executeSafeBatchOrders(result.buyPrices, result.sellPrices, marketData);
            }

            // 新增：自动撤销最远的旧单
            if (result.cancelOrders && result.cancelOrders.length > 0) {
                console.log(`开始撤销 ${result.cancelOrders.length} 个远单...`);
                for (const order of result.cancelOrders) {
                    await this.orderManager.cancelByPrice(order.price);  // 添加 await
                    await this.delay(1500);  // 撤单后等待1.5秒
                }
            }
        } catch (err) {
            console.error('周期执行异常:', err);
        }

    }




    // ==================== 获取市场数据 ====================
    async getCompleteMarketData() {
        const askEl = document.querySelector(BTCAutoTrading.SELECTORS.ASK_PRICE);
        const bidEl = document.querySelector(BTCAutoTrading.SELECTORS.BID_PRICE);

        if (!askEl || !bidEl) return { askPrice: null, bidPrice: null, existingSellOrders: [], existingBuyOrders: [] };

        const askPrice = parseFloat(askEl.textContent.replace(/[$,]/g, ''));
        const bidPrice = parseFloat(bidEl.textContent.replace(/[$,]/g, ''));

        await this.delay(BTCAutoTrading.TRADING_CONFIG.PRICE_UPDATE_DELAY);

        const rows = document.querySelectorAll(BTCAutoTrading.SELECTORS.ORDERS_TABLE_ROW);
        const existingSell = new Set();
        const existingBuy = new Set();

        rows.forEach(row => {
            const isSell = row.querySelectorAll(BTCAutoTrading.SELECTORS.RED_ELEMENTS).length > 0;
            const isBuy = row.querySelectorAll(BTCAutoTrading.SELECTORS.GREEN_ELEMENTS).length > 0;
            if (!isSell && !isBuy) return;

            const priceTexts = Array.from(row.querySelectorAll(BTCAutoTrading.SELECTORS.TEXT_CURRENT))
                .map(el => el.textContent.trim())
                .filter(t => t.includes('$') && !t.includes('Q'));
            if (priceTexts.length === 0) return;

            const price = parseFloat(priceTexts[0].replace(/[$,]/g, ''));
            if (price > 0) {
                if (isSell) existingSell.add(price);
                if (isBuy) existingBuy.add(price);
            }
        });

        return {
            askPrice,
            bidPrice,
            existingSellOrders: Array.from(existingSell).sort((a, b) => a - b),
            existingBuyOrders: Array.from(existingBuy).sort((a, b) => b - a)
        };
    }

    // ==================== 计算目标价格================
    calculateTargetPrices(marketData) {
        const { askPrice, bidPrice, existingSellOrders = [], existingBuyOrders = [] } = marketData;
        const cfg = BTCAutoTrading.GRID_STRATEGY_CONFIG;

        const midPrice = (askPrice + bidPrice) / 2;
        const windowSize = midPrice * cfg.WINDOW_PERCENT;
        const halfWindow = windowSize / 2;

        const sellCount = Math.round(cfg.TOTAL_ORDERS * cfg.SELL_RATIO);  // 目标卖单数 ≈27~28
        const buyCount  = cfg.TOTAL_ORDERS - sellCount;                    // 目标买单数 ≈22~23

        const interval = cfg.BASE_PRICE_INTERVAL;  // 统一买卖间隔

        // ========== 1. 计算当前窗口内“应该存在的理想订单” ==========
        const sellStart = Math.ceil((askPrice + cfg.SAFE_GAP) / interval) * interval;
        const idealSellPrices = [];
        for (let i = 0; i < sellCount; i++) {
            const p = sellStart + i * interval;
            if (p > midPrice + halfWindow + cfg.MAX_DRIFT_BUFFER) break;
            idealSellPrices.push(p);
        }

        const buyEnd = Math.floor((bidPrice - cfg.SAFE_GAP) / interval) * interval;
        const idealBuyPrices = [];
        for (let i = 0; i < buyCount; i++) {
            const p = buyEnd - i * interval;
            if (p < midPrice - halfWindow - cfg.MAX_DRIFT_BUFFER) break;
            if (p < cfg.MIN_VALID_PRICE) break;
            idealBuyPrices.push(p);
        }

        const idealPricesSet = new Set([...idealSellPrices, ...idealBuyPrices]);

        // ========== 2. 计算需要下的新单 ==========
        const newSellPrices = idealSellPrices.filter(p => !existingSellOrders.includes(p));
        const newBuyPrices  = idealBuyPrices.filter(p => !existingBuyOrders.includes(p));

        // ========== 3. 计算需要撤销的旧单（超出当前窗口的）==========
        const currentTotal = existingSellOrders.length + existingBuyOrders.length;
        const ordersToCancel = [];

        if (currentTotal > cfg.TOTAL_ORDERS || existingSellOrders.length > sellCount || existingBuyOrders.length > buyCount) {
            // 优先撤销最远的卖单（价格最高的）
            const farSellOrders = existingSellOrders
                .filter(p => !idealPricesSet.has(p))
                .sort((a, b) => b - a);  // 从高到低

            // 优先撤销最远的买单（价格最低的）
            const farBuyOrders = existingBuyOrders
                .filter(p => !idealPricesSet.has(p))
                .sort((a, b) => a - b);  // 从低到高

            // 合并并取最远的若干个，直到总单数回到50以内
            const allFar = [
                ...farSellOrders.map(p => ({ type: 'sell', price: p })),
                ...farBuyOrders.map(p => ({ type: 'buy', price: p }))
            ];

            // 按与中间价距离排序，越远越先撤
            allFar.sort((a, b) => Math.abs(b.price - midPrice) - Math.abs(a.price - midPrice));

            const excess = currentTotal - cfg.TOTAL_ORDERS;
            for (let i = 0; i < Math.max(excess, allFar.length); i++) {
                if (ordersToCancel.length >= 10) break; // 单次最多撤10单，防误操作
                ordersToCancel.push(allFar[i]);
            }
        }

        console.log(`中间价 $${midPrice.toFixed(1)} | 窗口 ±${halfWindow.toFixed(0)}`);
        console.log(`当前订单: ${existingSellOrders.length}卖 + ${existingBuyOrders.length}买 = ${currentTotal}`);
        console.log(`目标订单: ${idealSellPrices.length}卖 + ${idealBuyPrices.length}买`);
        console.log(`需下单: ${newSellPrices.length}卖 + ${newBuyPrices.length}买`);
        if (ordersToCancel.length > 0) {
            console.log(`需撤销: ${ordersToCancel.length}单 →`, ordersToCancel.map(o => `${o.type}-${o.price}`).join(', '));
        } else {
            console.log(`无需撤销订单`);
        }

        return {
            sellPrices: newSellPrices,
            buyPrices:  newBuyPrices,
            cancelOrders: ordersToCancel  // 新增：返回要撤销的订单列表
        };
    }

    // ==================== 安全批量下单 ====================
    async executeSafeBatchOrders(buyPrices, sellPrices, marketData) {
        const orders = [
            ...buyPrices.map(p => ({ type: 'buy', price: p })),
            ...sellPrices.map(p => ({ type: 'sell', price: p }))
        ];

        console.log(`准备下 ${orders.length} 个新单`);
        console.log(`新单:`,orders);
        for (const order of orders) {
            const key = `${order.type}-${order.price}`;
            console.log(`准备下`,key);
            const success = order.type === 'buy'
                ? await this.orderManager.placeLimitBuy(order.price)
                : await this.orderManager.placeLimitSell(order.price);

            console.log(`success`,success);
            if (success) {
                this.lastOrderTime = Date.now();
                await this.delay(BTCAutoTrading.TRADING_CONFIG.ORDER_COOLDOWN);
            }
            console.log(`完成`,key);
        }
        console.log('本轮下单完成');
    }

    // ==================== 工具方法 ====================
    clearOrderHistory() {
        this.processedOrders.clear();
        this.lastOrderTime = 0;
        this.cycleCount = 0;
        console.log('订单记录已清空');
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            cycleCount: this.cycleCount,
            processedCount: this.processedOrders.size,
            lastOrderTime: this.lastOrderTime ? new Date(this.lastOrderTime).toLocaleTimeString() : '无'
        };
    }

    showWarningMessage(msg) {
        alert(`警告：${msg}`);
        console.warn(`警告：${msg}`);
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ==================== 下单管理器 ====================
class BTCOrderManager {
    static CONFIG = { UI_OPERATION_DELAY: 500, INPUT_DELAY: 300, ORDER_SUBMIT_DELAY: 1000 };

    async placeLimitBuy(price) {
        return this.placeOrder(price, 'buy');
    }

    async placeLimitSell(price) {
        return this.placeOrder(price, 'sell');
    }

    async placeOrder(price, type) {
        console.warn(`placeOrder：`,price, type);
        try {
            const button = type === 'buy' ? this.findBuyButton() : this.findSellButton();
            if (!button) return false;
            button.click();

            await this.delay(BTCOrderManager.CONFIG.UI_OPERATION_DELAY);

            const priceInput = document.querySelector(BTCAutoTrading.SELECTORS.PRICE_INPUT);
            if (!priceInput) return false;

            priceInput.value = price;
            priceInput.dispatchEvent(new Event('input', { bubbles: true }));
            priceInput.dispatchEvent(new Event('change', { bubbles: true }));

            await this.delay(BTCOrderManager.CONFIG.INPUT_DELAY);

            const submit = document.querySelector(BTCAutoTrading.SELECTORS.SUBMIT_BUTTON);
            if (!submit || submit.disabled) return false;
            submit.click();

            return true;
        } catch (err) {
            console.error('下单异常:', err);
            return false;
        }
    }

    findBuyButton() { return this.findDirectionButton('buy'); }
    findSellButton() { return this.findDirectionButton('sell'); }

    findDirectionButton(dir) {
        const isBuy = dir === 'buy';
        const cls = isBuy ? BTCAutoTrading.CLASS_MATCH.BUY_BUTTON : BTCAutoTrading.CLASS_MATCH.SELL_BUTTON;
        const texts = isBuy ? BTCAutoTrading.TEXT_MATCH.BUY_BUTTON : BTCAutoTrading.TEXT_MATCH.SELL_BUTTON;

        return document.querySelector(`button.${cls}`)
            || Array.from(document.querySelectorAll('button')).find(b =>
                texts.some(t => b.textContent.includes(t))
            );
    }

    // 新增简化方法
    async getCurrentPrice() {
        const askEl = document.querySelector(BTCAutoTrading.SELECTORS.ASK_PRICE);
        const bidEl = document.querySelector(BTCAutoTrading.SELECTORS.BID_PRICE);
        
        if (!askEl || !bidEl) return null;
        
        const askPrice = parseFloat(askEl.textContent.replace(/[$,]/g, ''));
        const bidPrice = parseFloat(bidEl.textContent.replace(/[$,]/g, ''));
        
        return (askPrice + bidPrice) / 2;
    }

    async cancelByPrice(price) {
        const currentPrice = await this.getCurrentPrice();
        if (currentPrice) {
            const prices = Array.isArray(price) ? price : [price];
            const shouldSkip = prices.some(targetPrice => {
                const targetNum = Number(String(targetPrice).replace(/[^0-9.]/g, ''));
                if (!targetNum) return false;
                
                const cfg = BTCAutoTrading.GRID_STRATEGY_CONFIG;
                const priceDiff = Math.abs(targetNum - currentPrice);
                const isNearCurrentPrice = priceDiff <= cfg.BASE_PRICE_INTERVAL;
                
                if (isNearCurrentPrice) {
                    console.log(`跳过撤单：价格接近当前价格 (差值: ${priceDiff.toFixed(1)})`);
                }
                return isNearCurrentPrice;
            });
            
            if (shouldSkip) return;
        }
      const prices = Array.isArray(price) ? price : [price];
      
      for (let target of prices) {
        const targetNum = Number(String(target).replace(/[^0-9.]/g, ''));
        if (!targetNum) continue;

        console.log(`正在查找价格 ≈ $${targetNum.toLocaleString()} 的挂单...`);

        const allPriceSpans = document.querySelectorAll('div.justify-self-end > span.text-current');

        let found = false;
        for (const span of allPriceSpans) {
          const text = span.textContent.trim();
          const priceInPage = Number(text.replace(/[$,]/g, ''));
          
          if (priceInPage === targetNum) {
            const row = span.closest('[data-testid="orders-table-row"]');
            const cancelBtn = row?.querySelector('button[title="取消订单"]');
            
            if (cancelBtn) {
              console.log(`找到！正在取消 $${targetNum.toLocaleString()} 的订单`);
              cancelBtn.scrollIntoView({ block: 'center' });
              cancelBtn.click();

              await new Promise(resolve => {
                let attempts = 0;
                const timer = setInterval(() => {
                  attempts++;
                  
                  // 多种方式查找确认按钮
                  const confirmBtn = 
                    // 方式1：通过类名和文本内容
                    [...document.querySelectorAll('button')].find(btn => 
                      btn.textContent.trim() === '确认' && 
                      btn.classList.contains('bg-red')
                    ) ||
                    // 方式2：通过autofocus属性
                    document.querySelector('button[autofocus]') ||
                    // 方式3：通过精确的类名组合
                    document.querySelector('button.bg-red.h-8.px-3.py-1.text-xs.rounded-md') ||
                    // 方式4：通过文本内容（宽松匹配）
                    [...document.querySelectorAll('button')].find(btn => 
                      btn.textContent.includes('确认')
                    );

                  console.log('找到确认按钮:', confirmBtn); // 调试信息

                  if (confirmBtn && confirmBtn.offsetParent !== null) {
                    clearInterval(timer);
                    setTimeout(() => {
                      confirmBtn.click();
                      console.log(`已确认取消 $${targetNum.toLocaleString()}`);
                      resolve();
                    }, 300); // 稍微延长等待时间
                  }

                  if (attempts > 50) {
                    clearInterval(timer);
                    console.warn('确认按钮超时，可能弹窗被拦截或已自动关闭');
                    resolve();
                  }
                }, 300);
              });

              found = true;
              break;
            }
          }
        }

        if (!found) {
          console.warn(`未找到 $${targetNum.toLocaleString()} 的挂单（或已被取消）`);
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      console.log('全部取消任务执行完毕！');
    }

    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ==================== 全局实例 ====================
const btcAutoTrader = new BTCAutoTrading();

// ==================== 快捷指令（直接粘到控制台使用）===================
// btcAutoTrader.stopAutoTrading();         // 停止
// btcAutoTrader.getStatus();               // 查看状态
// btcAutoTrader.clearOrderHistory();       // 清空记录

// 建议第一次运行前先手动设置好仓位数量，然后执行：
btcAutoTrader.startAutoTrading(3000);